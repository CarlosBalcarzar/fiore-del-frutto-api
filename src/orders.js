import {z} from 'zod';
import {transaction} from './db.js';
const product=z.object({sku:z.string().min(1).max(50),quantity:z.number().int().min(1).max(99)});
export const orderSchema=z.object({
  idempotency_key:z.string().uuid(),
  items:z.array(product).min(1).max(24),
  delivery_method:z.enum(['DELIVERY','PICKUP']),
  contact_name:z.string().trim().min(2).max(200),
  contact_phone:z.string().trim().min(7).max(30),
  delivery_address:z.string().trim().max(500).optional().default('')
}).superRefine((v,ctx)=>{
  if(v.delivery_method==='DELIVERY'&&!v.delivery_address)ctx.addIssue({code:'custom',path:['delivery_address'],message:'Dirección obligatoria'});
  if(new Set(v.items.map(i=>i.sku)).size!==v.items.length)ctx.addIssue({code:'custom',path:['items'],message:'SKU duplicados'});
});
export class HttpError extends Error {constructor(status,code){super(code);this.status=status;this.code=code}}
const money=n=>Number(n).toFixed(2);
export async function createOrder(user,input){
  const payload=orderSchema.parse(input);
  return transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user.id+payload.idempotency_key]);
    const old=await db.query('SELECT id,order_number,subtotal_bs,shipping_fee_bs,status FROM fiore.orders WHERE customer_id=$1 AND idempotency_key=$2',[user.id,payload.idempotency_key]);
    if(old.rowCount)return {...old.rows[0],replayed:true};
    const settings=(await db.query('SELECT delivery_enabled,pickup_enabled,delivery_fee_bs,shipping_payer FROM fiore.store_settings WHERE id=1')).rows[0];
    if(!settings)throw new HttpError(503,'STORE_NOT_CONFIGURED');
    if(payload.delivery_method==='DELIVERY'&&(!settings.delivery_enabled||settings.delivery_fee_bs===null))throw new HttpError(409,'DELIVERY_NOT_CONFIGURED');
    if(payload.delivery_method==='PICKUP'&&!settings.pickup_enabled)throw new HttpError(409,'PICKUP_DISABLED');
    const skus=payload.items.map(x=>x.sku).sort();
    const {rows}=await db.query(`SELECT v.id,v.sku,v.price_bs,p.name,v.is_active,p.is_active AS product_active,
      i.physical_stock,i.safety_stock,i.committed_stock
      FROM fiore.product_variants v JOIN fiore.products p ON p.id=v.product_id
      JOIN fiore.inventory i ON i.variant_id=v.id WHERE v.sku=ANY($1::text[]) ORDER BY v.id FOR UPDATE OF i`,[skus]);
    if(rows.length!==skus.length)throw new HttpError(400,'PRODUCT_NOT_FOUND');
    const mapped=new Map(rows.map(x=>[x.sku,x]));
    const lines=payload.items.map(item=>{
      const x=mapped.get(item.sku);
      if(!x.is_active||!x.product_active||Number(x.price_bs)<=0)throw new HttpError(409,'PRODUCT_UNAVAILABLE');
      if(x.physical_stock-x.safety_stock-x.committed_stock<item.quantity)throw new HttpError(409,'INSUFFICIENT_STOCK:'+item.sku);
      return {...x,quantity:item.quantity};
    });
    const subtotal=lines.reduce((v,x)=>v+Math.round(Number(x.price_bs)*100)*x.quantity,0)/100;
    const fee=payload.delivery_method==='DELIVERY' ? Number(settings.delivery_fee_bs) : 0;
    const payer=payload.delivery_method==='DELIVERY'?settings.shipping_payer:null;
    const fullName=user.metadata.full_name || user.email?.split('@')[0] || 'Cliente';
    await db.query(`INSERT INTO fiore.customer_profiles(user_id,first_name) VALUES($1,$2)
      ON CONFLICT(user_id) DO NOTHING`,[user.id,String(fullName).slice(0,100)]);
    const {rows:[order]}=await db.query(`INSERT INTO fiore.orders
      (customer_id,idempotency_key,status,payment_method,delivery_method,contact_name,contact_phone,
      delivery_address,subtotal_bs,shipping_fee_bs,shipping_payer)
      VALUES($1,$2,'CONFIRMED','CASH',$3,$4,$5,$6,$7,$8,$9)
      RETURNING id,order_number,subtotal_bs,shipping_fee_bs,shipping_payer,status`,
      [user.id,payload.idempotency_key,payload.delivery_method,payload.contact_name,payload.contact_phone,
       payload.delivery_method==='DELIVERY'?payload.delivery_address:null,money(subtotal),fee,payer]);
    for(const x of lines){
      await db.query(`INSERT INTO fiore.order_items(order_id,variant_id,product_name,sku,quantity,unit_price_bs)
      VALUES($1,$2,$3,$4,$5,$6)`,[order.id,x.id,x.name,x.sku,x.quantity,x.price_bs]);
      await db.query(`UPDATE fiore.inventory SET committed_stock=committed_stock+$1,updated_at=NOW() WHERE variant_id=$2`,[x.quantity,x.id]);
      await db.query(`INSERT INTO fiore.inventory_movements
        (variant_id,movement_type,committed_delta,reason) VALUES($1,'ORDER_COMMIT',$2,$3)`,[x.id,x.quantity,`Pedido FF-${order.order_number}`]);
    }
    await db.query(`INSERT INTO fiore.order_status_history(order_id,new_status,note)
      VALUES($1,'CONFIRMED','Pedido aceptado automáticamente')`,[order.id]);
    const amount=subtotal+(payer==='CUSTOMER'?fee:0);
    await db.query(`INSERT INTO fiore.payments(order_id,method,status,amount_bs)
      VALUES($1,'CASH','PENDING',$2)`,[order.id,money(amount)]);
    if(payload.delivery_method==='DELIVERY')await db.query('INSERT INTO fiore.deliveries(order_id) VALUES($1)',[order.id]);
    return {...order,replayed:false};
  });
}
const states={CONFIRMED:['PREPARING','CANCELLED'],PREPARING:['READY','CANCELLED'],READY:['IN_TRANSIT','DELIVERED','CANCELLED'],IN_TRANSIT:['DELIVERED'],DELIVERED:[],CANCELLED:[]};
export const adminCode=id=>id ? 'FF-ADM-'+id.replaceAll('-','').slice(0,12).toUpperCase() : null;
export async function changeOrderStatus(orderId,status,adminId,customerMessage=null){
  if(!(status in states))throw new HttpError(400,'INVALID_STATUS');
  return transaction(async db=>{
    const {rows:[order]}=await db.query('SELECT * FROM fiore.orders WHERE id=$1 FOR UPDATE',[orderId]);
    if(!order)throw new HttpError(404,'ORDER_NOT_FOUND');
    if(!states[order.status].includes(status))throw new HttpError(409,'INVALID_STATUS_TRANSITION');
    const {rows:items}=await db.query('SELECT variant_id,quantity FROM fiore.order_items WHERE order_id=$1 ORDER BY variant_id',[orderId]);
    for(const item of items){
      if(status==='CANCELLED'){
        await db.query('UPDATE fiore.inventory SET committed_stock=committed_stock-$1,updated_at=NOW() WHERE variant_id=$2',[item.quantity,item.variant_id]);
        await db.query(`INSERT INTO fiore.inventory_movements(variant_id,movement_type,committed_delta,reason)
          VALUES($1,'ORDER_CANCEL',$2,$3)`,[item.variant_id,-item.quantity,`Pedido ${order.order_number} cancelado`]);
      }
      if(status==='DELIVERED'){
        await db.query(`UPDATE fiore.inventory SET committed_stock=committed_stock-$1,physical_stock=physical_stock-$1,updated_at=NOW() WHERE variant_id=$2`,[item.quantity,item.variant_id]);
        await db.query(`INSERT INTO fiore.inventory_movements(variant_id,movement_type,physical_delta,committed_delta,reason)
          VALUES($1,'ORDER_DELIVER',$2,$2,$3)`,[item.variant_id,-item.quantity,`Pedido ${order.order_number} entregado`]);
      }
    }
    await db.query('UPDATE fiore.orders SET status=$2,supervisor_id=COALESCE(supervisor_id,$3),updated_at=NOW() WHERE id=$1',[orderId,status,adminId]);
    await db.query('INSERT INTO fiore.order_status_history(order_id,previous_status,new_status,admin_code,customer_message) VALUES($1,$2,$3,$4,$5)',[orderId,order.status,status,adminCode(adminId),customerMessage]);
    if(status==='DELIVERED')await db.query('UPDATE fiore.deliveries SET delivered_at=NOW() WHERE order_id=$1',[orderId]);
    return {id:orderId,status};
  });
}
