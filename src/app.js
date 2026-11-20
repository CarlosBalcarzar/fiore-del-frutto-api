import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import {rateLimit} from 'express-rate-limit';
import {z,ZodError} from 'zod';
import {pool,transaction} from './db.js';
import {requireAuth,requireAdmin} from './auth.js';
import {createOrder,changeOrderStatus,HttpError} from './orders.js';
export const app=express();
app.disable('x-powered-by');
if (process.env.RENDER === 'true') app.set('trust proxy', 1);
app.use(helmet());
const origins=(process.env.FRONTEND_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim());
app.use(cors({origin:(origin,cb)=>cb(null,!origin||origins.includes(origin)),methods:['GET','POST','PUT','PATCH']}));
app.use(express.json({limit:'24kb'}));
app.use('/api',rateLimit({windowMs:15*60*1000,limit:120,standardHeaders:'draft-7',legacyHeaders:false}));
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const uuid=z.string().uuid();
app.get('/api/health',(req,res)=>res.json({status:'ok',application:'Fiore del frutto API',version:'5.0'}));
app.get('/api/products',asyncRoute(async(req,res)=>{
  const {rows}=await pool.query(`SELECT p.name,p.description,v.sku,v.volume_ml,v.price_bs,
    GREATEST(0,i.physical_stock-i.safety_stock-i.committed_stock) AS available_stock
    FROM fiore.products p JOIN fiore.product_variants v ON v.product_id=p.id
    JOIN fiore.inventory i ON i.variant_id=v.id
    WHERE p.is_active AND v.is_active AND v.price_bs>0 ORDER BY p.name,v.volume_ml`);
  res.json({products:rows});
}));
app.get('/api/store',asyncRoute(async(req,res)=>{
  const {rows:[v]}=await pool.query('SELECT delivery_enabled,pickup_enabled,delivery_fee_bs,shipping_payer FROM fiore.store_settings WHERE id=1');
  res.json(v);
}));
app.get('/api/me',requireAuth,(req,res)=>res.json({id:req.user.id,email:req.user.email,name:req.user.metadata.full_name||'',admin:req.user.admin}));
app.get('/api/me/profile',requireAuth,asyncRoute(async(req,res)=>{
  const {rows:[p]}=await pool.query('SELECT first_name,last_name,saved_phone,saved_address FROM fiore.customer_profiles WHERE user_id=$1',[req.user.id]);res.json(p||{});
}));
app.put('/api/me/profile',requireAuth,asyncRoute(async(req,res)=>{
  const data=z.object({first_name:z.string().trim().max(100).nullable().optional(),last_name:z.string().trim().max(100).nullable().optional(),saved_phone:z.string().trim().max(30).nullable().optional(),saved_address:z.string().trim().max(500).nullable().optional()}).strict().parse(req.body);
  const {rows:[p]}=await pool.query(`INSERT INTO fiore.customer_profiles(user_id,first_name,last_name,saved_phone,saved_address)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET
    first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,saved_phone=EXCLUDED.saved_phone,
    saved_address=EXCLUDED.saved_address,updated_at=NOW()
    RETURNING first_name,last_name,saved_phone,saved_address`,[req.user.id,data.first_name??null,data.last_name??null,data.saved_phone??null,data.saved_address??null]);res.json(p);
}));
app.post('/api/orders',requireAuth,asyncRoute(async(req,res)=>res.status(201).json(await createOrder(req.user,req.body))));
app.get('/api/me/orders',requireAuth,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query(`SELECT id,order_number,status,delivery_method,subtotal_bs,shipping_fee_bs,shipping_payer,created_at
   FROM fiore.orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[req.user.id]);res.json({orders:rows});
}));
app.get('/api/me/orders/:id',requireAuth,asyncRoute(async(req,res)=>{
  const id=uuid.parse(req.params.id);
  const {rows:[o]}=await pool.query(`SELECT id,order_number,status,delivery_method,contact_name,contact_phone,delivery_address,
   subtotal_bs,shipping_fee_bs,shipping_payer,created_at FROM fiore.orders WHERE id=$1 AND customer_id=$2`,[id,req.user.id]);
  if(!o)throw new HttpError(404,'ORDER_NOT_FOUND');
  const {rows:items}=await pool.query('SELECT product_name,sku,quantity,unit_price_bs FROM fiore.order_items WHERE order_id=$1',[id]);
  const {rows:history}=await pool.query('SELECT new_status,created_at FROM fiore.order_status_history WHERE order_id=$1 ORDER BY created_at',[id]);
  res.json({order:o,items,history});
}));
app.get('/api/admin/inventory',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query(`SELECT p.name,v.sku,v.id AS variant_id,v.price_bs,v.is_active,
    i.physical_stock,i.safety_stock,i.committed_stock,
    (i.physical_stock-i.safety_stock-i.committed_stock) AS available_stock
    FROM fiore.products p JOIN fiore.product_variants v ON v.product_id=p.id
    JOIN fiore.inventory i ON i.variant_id=v.id ORDER BY p.name`);res.json({inventory:rows});
}));
app.post('/api/admin/inventory/restock',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const d=z.object({variant_id:uuid,quantity:z.number().int().positive(),reason:z.string().trim().min(3).max(500)}).parse(req.body);
  await pool.query('SELECT fiore.register_stock($1,$2,$3)',[d.variant_id,d.quantity,d.reason]);res.json({ok:true});
}));
app.post('/api/admin/inventory/reserve',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const d=z.object({variant_id:uuid,safety_stock:z.number().int().nonnegative(),reason:z.string().trim().min(3).max(500)}).parse(req.body);
  await pool.query('SELECT fiore.set_safety_stock($1,$2,$3)',[d.variant_id,d.safety_stock,d.reason]);res.json({ok:true});
}));
app.patch('/api/admin/products/:sku',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const sku=z.string().max(50).parse(req.params.sku);
  const d=z.object({price_bs:z.number().positive().max(999999).optional(),is_active:z.boolean().optional()}).strict().parse(req.body);
  if(!Object.keys(d).length)throw new HttpError(400,'NO_CHANGES');
  const {rows:[p]}=await pool.query(`UPDATE fiore.product_variants SET price_bs=COALESCE($2,price_bs),is_active=COALESCE($3,is_active)
    WHERE sku=$1 RETURNING sku,price_bs,is_active`,[sku,d.price_bs??null,d.is_active??null]);if(!p)throw new HttpError(404,'PRODUCT_NOT_FOUND');res.json(p);
}));
app.get('/api/admin/orders',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const {rows}=await pool.query(`SELECT o.id,o.order_number,o.status,o.contact_name,o.contact_phone,o.delivery_method,
   o.delivery_address,o.subtotal_bs,o.shipping_fee_bs,o.shipping_payer,o.created_at,
   d.courier_code,d.courier_advance_bs,p.status AS payment_status
   FROM fiore.orders o LEFT JOIN fiore.deliveries d ON d.order_id=o.id
   LEFT JOIN fiore.payments p ON p.order_id=o.id ORDER BY o.created_at DESC LIMIT 100`);res.json({orders:rows});
}));
app.patch('/api/admin/orders/:id/status',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const d=z.object({status:z.enum(['CONFIRMED','PREPARING','READY','IN_TRANSIT','DELIVERED','CANCELLED']),note:z.string().max(500).optional()}).parse(req.body);
  res.json(await changeOrderStatus(uuid.parse(req.params.id),d.status,d.note));
}));
app.patch('/api/admin/orders/:id/courier',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const d=z.object({courier_code:z.string().trim().min(2).max(30),courier_advance_bs:z.number().min(0).max(999999)}).parse(req.body);
  const {rowCount}=await pool.query(`UPDATE fiore.deliveries SET courier_code=$2,courier_advance_bs=$3,pickup_at=COALESCE(pickup_at,NOW()) WHERE order_id=$1`,[uuid.parse(req.params.id),d.courier_code,d.courier_advance_bs]);
  if(!rowCount)throw new HttpError(404,'DELIVERY_NOT_FOUND');res.json({ok:true});
}));
app.patch('/api/admin/orders/:id/payment',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const d=z.object({status:z.enum(['RECEIVED','REFUNDED']),note:z.string().max(500).optional()}).parse(req.body);
  const id=uuid.parse(req.params.id);
  const {rowCount}=await pool.query(`
    UPDATE fiore.payments
    SET status=$2,
        received_at=CASE WHEN $4::boolean THEN COALESCE(received_at, NOW()) ELSE received_at END,
        note=$3
    WHERE order_id=$1
  `,[id,d.status,d.note??null,d.status==='RECEIVED']);
  if(!rowCount)throw new HttpError(404,'PAYMENT_NOT_FOUND');res.json({ok:true});
}));
app.get('/api/admin/store',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const {rows:[p]}=await pool.query('SELECT * FROM fiore.store_settings WHERE id=1');res.json(p);
}));
app.put('/api/admin/store',requireAuth,requireAdmin,asyncRoute(async(req,res)=>{
  const d=z.object({delivery_enabled:z.boolean(),pickup_enabled:z.boolean(),delivery_fee_bs:z.number().nonnegative().nullable(),shipping_payer:z.enum(['CUSTOMER','BUSINESS'])}).parse(req.body);
  const {rows:[p]}=await pool.query(`UPDATE fiore.store_settings SET delivery_enabled=$1,pickup_enabled=$2,delivery_fee_bs=$3,shipping_payer=$4 WHERE id=1 RETURNING *`,[d.delivery_enabled,d.pickup_enabled,d.delivery_fee_bs,d.shipping_payer]);res.json(p);
}));
app.use((err,req,res,next)=>{
  if(err instanceof ZodError)return res.status(400).json({error:'INVALID_INPUT',details:err.issues.map(x=>({field:x.path.join('.'),message:x.message}))});
  if(err instanceof HttpError)return res.status(err.status).json({error:err.code});
  console.error('API failure:',err.code||err.message);
  res.status(500).json({error:'SERVER_ERROR'});
});
