import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean));
export async function requireAuth(req,res,next) {
  try {
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!match || !supabase) return res.status(401).json({error:'AUTH_REQUIRED'});
    // The actual account is verified against Supabase Auth; no decoded JWT is trusted without verification.
    const {data,error} = await supabase.auth.getUser(match[1]);
    if (error || !data.user || !data.user.email_confirmed_at) return res.status(401).json({error:'INVALID_SESSION'});
    req.user={id:data.user.id,email:data.user.email,metadata:data.user.user_metadata||{},
      admin:adminEmails.has((data.user.email||'').toLowerCase())};
    next();
  } catch(err){next(err)}
}
export function requireAdmin(req,res,next){ if(!req.user?.admin)return res.status(403).json({error:'ADMIN_REQUIRED'});next(); }
