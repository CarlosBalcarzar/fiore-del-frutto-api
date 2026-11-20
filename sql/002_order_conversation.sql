ALTER TABLE fiore.orders ADD COLUMN supervisor_id uuid;
ALTER TABLE fiore.order_status_history ADD COLUMN admin_code text;
ALTER TABLE fiore.order_status_history ADD COLUMN customer_message text;

CREATE TABLE fiore.order_messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 order_id uuid NOT NULL REFERENCES fiore.orders(id),
 author text NOT NULL CHECK (author IN ('customer','admin')),
 admin_code text,
 body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_messages_order_id_idx ON fiore.order_messages(order_id,id);
ALTER TABLE fiore.order_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_access ON fiore.order_messages TO fiore_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON fiore.order_messages TO fiore_api;
GRANT USAGE ON SEQUENCE fiore.order_messages_id_seq TO fiore_api;
