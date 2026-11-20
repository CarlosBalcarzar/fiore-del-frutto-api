CREATE SCHEMA fiore;
REVOKE ALL ON SCHEMA fiore FROM PUBLIC, anon, authenticated;

CREATE TABLE fiore.products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE,
 description text, is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE fiore.product_variants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES fiore.products,
 sku text NOT NULL UNIQUE, volume_ml integer NOT NULL CHECK (volume_ml > 0),
 price_bs numeric(12,2) NOT NULL CHECK (price_bs > 0), is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE fiore.inventory (
 variant_id uuid PRIMARY KEY REFERENCES fiore.product_variants,
 physical_stock integer NOT NULL DEFAULT 0 CHECK (physical_stock >= 0),
 safety_stock integer NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
 committed_stock integer NOT NULL DEFAULT 0 CHECK (committed_stock >= 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (physical_stock >= safety_stock + committed_stock)
);
CREATE TABLE fiore.customer_profiles (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id), first_name text, last_name text,
 saved_phone text, saved_address text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fiore.orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number integer GENERATED ALWAYS AS IDENTITY UNIQUE,
 customer_id uuid NOT NULL REFERENCES fiore.customer_profiles(user_id), idempotency_key uuid NOT NULL,
 status text NOT NULL CHECK (status IN ('CONFIRMED','PREPARING','READY','IN_TRANSIT','DELIVERED','CANCELLED')),
 payment_method text NOT NULL CHECK (payment_method = 'CASH'),
 delivery_method text NOT NULL CHECK (delivery_method IN ('PICKUP','DELIVERY')),
 contact_name text NOT NULL, contact_phone text NOT NULL, delivery_address text,
 subtotal_bs numeric(12,2) NOT NULL CHECK (subtotal_bs > 0),
 shipping_fee_bs numeric(12,2) NOT NULL CHECK (shipping_fee_bs >= 0),
 shipping_payer text CHECK (shipping_payer IN ('CUSTOMER','BUSINESS')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,idempotency_key)
);
CREATE TABLE fiore.order_items (
 order_id uuid NOT NULL REFERENCES fiore.orders, variant_id uuid NOT NULL REFERENCES fiore.product_variants,
 product_name text NOT NULL, sku text NOT NULL, quantity integer NOT NULL CHECK (quantity > 0),
 unit_price_bs numeric(12,2) NOT NULL CHECK (unit_price_bs > 0), PRIMARY KEY(order_id,variant_id)
);
CREATE TABLE fiore.order_status_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, order_id uuid NOT NULL REFERENCES fiore.orders,
 previous_status text, new_status text NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fiore.payments (
 order_id uuid PRIMARY KEY REFERENCES fiore.orders, method text NOT NULL CHECK (method = 'CASH'),
 status text NOT NULL CHECK (status IN ('PENDING','RECEIVED','REFUNDED')),
 amount_bs numeric(12,2) NOT NULL CHECK (amount_bs > 0), received_at timestamptz, note text
);
CREATE TABLE fiore.deliveries (
 order_id uuid PRIMARY KEY REFERENCES fiore.orders, courier_code text,
 courier_advance_bs numeric(12,2) CHECK (courier_advance_bs >= 0),
 pickup_at timestamptz, delivered_at timestamptz
);
CREATE TABLE fiore.inventory_movements (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, variant_id uuid NOT NULL REFERENCES fiore.product_variants,
 movement_type text NOT NULL, physical_delta integer NOT NULL DEFAULT 0,
 committed_delta integer NOT NULL DEFAULT 0, safety_delta integer NOT NULL DEFAULT 0,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fiore.store_settings (
 id integer PRIMARY KEY CHECK (id = 1), delivery_enabled boolean NOT NULL, pickup_enabled boolean NOT NULL,
 delivery_fee_bs numeric(12,2) CHECK (delivery_fee_bs >= 0),
 shipping_payer text NOT NULL DEFAULT 'CUSTOMER' CHECK (shipping_payer IN ('CUSTOMER','BUSINESS'))
);
INSERT INTO fiore.store_settings VALUES (1,false,true,NULL,'CUSTOMER');

WITH seed(name,sku,stock) AS (
 VALUES ('Coco','CHA-COC-500',11),('Durazno','CHA-DUR-500',0),
        ('Naranja','CHA-NAR-500',0),('Piña','CHA-PIN-500',40)
), products AS (
 INSERT INTO fiore.products(name) SELECT name FROM seed RETURNING id,name
), variants AS (
 INSERT INTO fiore.product_variants(product_id,sku,volume_ml,price_bs)
 SELECT p.id,s.sku,500,70 FROM products p JOIN seed s USING(name) RETURNING id,sku
)
INSERT INTO fiore.inventory(variant_id,physical_stock)
SELECT v.id,s.stock FROM variants v JOIN seed s USING(sku);

CREATE ROLE fiore_api NOLOGIN;
GRANT USAGE ON SCHEMA fiore TO fiore_api;
GRANT SELECT ON ALL TABLES IN SCHEMA fiore TO fiore_api;
GRANT INSERT ON fiore.orders,fiore.order_items,fiore.order_status_history,fiore.payments,
 fiore.deliveries,fiore.inventory_movements,fiore.customer_profiles TO fiore_api;
GRANT UPDATE ON fiore.orders,fiore.payments,fiore.deliveries,fiore.inventory,fiore.store_settings,fiore.customer_profiles TO fiore_api;
GRANT UPDATE (is_active,price_bs) ON fiore.product_variants TO fiore_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA fiore TO fiore_api;
DO $$
DECLARE t text;
BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='fiore' LOOP
  EXECUTE format('ALTER TABLE fiore.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY api_access ON fiore.%I TO fiore_api USING (true) WITH CHECK (true)',t);
 END LOOP;
END;
$$;
CREATE OR REPLACE FUNCTION fiore.register_stock(p_variant_id UUID,p_quantity INTEGER,p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF p_quantity IS NULL OR p_quantity<=0 THEN RAISE EXCEPTION 'Cantidad inválida'; END IF;
 IF NULLIF(BTRIM(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Motivo obligatorio'; END IF;
 UPDATE fiore.inventory SET physical_stock=physical_stock+p_quantity,updated_at=NOW()
 WHERE variant_id=p_variant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Inventario no encontrado'; END IF;
 INSERT INTO fiore.inventory_movements(variant_id,movement_type,physical_delta,reason)
 VALUES(p_variant_id,'RESTOCK',p_quantity,p_reason);
END;$$;
CREATE OR REPLACE FUNCTION fiore.set_safety_stock(p_variant_id UUID,p_new_safety INTEGER,p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_old INTEGER;v_physical INTEGER;v_committed INTEGER;
BEGIN
 IF p_new_safety IS NULL OR p_new_safety<0 THEN RAISE EXCEPTION 'Reserva inválida'; END IF;
 IF NULLIF(BTRIM(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Motivo obligatorio'; END IF;
 SELECT safety_stock,physical_stock,committed_stock INTO v_old,v_physical,v_committed
 FROM fiore.inventory WHERE variant_id=p_variant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Inventario no encontrado'; END IF;
 IF p_new_safety+v_committed>v_physical THEN RAISE EXCEPTION 'Reserva supera stock libre'; END IF;
 IF p_new_safety=v_old THEN RETURN; END IF;
 UPDATE fiore.inventory SET safety_stock=p_new_safety,updated_at=NOW() WHERE variant_id=p_variant_id;
 INSERT INTO fiore.inventory_movements(variant_id,movement_type,safety_delta,reason)
 VALUES(p_variant_id,'SAFETY_ADJUSTMENT',p_new_safety-v_old,p_reason);
END;$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fiore FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA fiore TO fiore_api;
