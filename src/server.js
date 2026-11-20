import 'dotenv/config';
import {app} from './app.js';
import {pool} from './db.js';
const port=Number(process.env.PORT||3001);
const server=app.listen(port,process.env.HOST || '0.0.0.0',()=>console.log(`Fiore del frutto API: http://127.0.0.1:${port}/api/health`));
process.on('SIGINT',async()=>{server.close();await pool.end();process.exit(0)});
