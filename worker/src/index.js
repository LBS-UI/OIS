const COOKIE_NAME = 'ngsc_session';
const SESSION_TTL = 60 * 60 * 8;
const corsHeaders = { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin' };
const json = (body, status=200, extra={}) => new Response(JSON.stringify(body), {status, headers:{...corsHeaders,...extra}});
const fail = (message,status=400) => json({error:message},status);
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const encoder = new TextEncoder();
function b64url(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function decodeB64url(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function sign(value, secret){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));}
async function makeSession(username, secret){const payload=b64url(encoder.encode(JSON.stringify({sub:username,exp:Math.floor(Date.now()/1000)+SESSION_TTL})));return `${payload}.${b64url(await sign(payload,secret))}`;}
async function readSession(request, secret){const cookie=request.headers.get('Cookie')||'';const match=cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE_NAME+'='));if(!match)return null;const value=match.slice(COOKIE_NAME.length+1);const parts=value.split('.');if(parts.length!==2)return null;try{const expected=await sign(parts[0],secret);const actual=decodeB64url(parts[1]);if(expected.length!==actual.length||!crypto.subtle.timingSafeEqual) {let diff=0;for(let i=0;i<Math.min(expected.length,actual.length);i++)diff|=expected[i]^actual[i];if(diff||expected.length!==actual.length)return null;} else if(!crypto.subtle.timingSafeEqual(expected,actual))return null;const p=JSON.parse(new TextDecoder().decode(decodeB64url(parts[0])));if(!p.sub||p.exp<Math.floor(Date.now()/1000))return null;return p.sub;}catch{return null;}}
function cookie(value,maxAge=SESSION_TTL){return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;}
function mapRecord(r){return {id:r.id,qrToken:r.qr_token,category:r.category,pcNumber:r.pc_number||'',fullName:r.full_name,grade:r.grade||'',section:r.section||'',school:r.school||'',office:r.office||'',position:r.position||'',preTest:r.pre_test,postTest:r.post_test,feedback:r.feedback||'',createdAt:r.created_at,updatedAt:r.updated_at};}
function cleanString(v,max=160){if(v===null||v===undefined)return null;const s=String(v).trim();return s?s.slice(0,max):null;}
function cleanScore(v){if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)&&n>=0?n:NaN;}
function normalize(body){const category=['student','employee','visitor'].includes(body.category)?body.category:null;if(!category)throw new Error('Choose a valid registration category.');const fullName=cleanString(body.fullName,160);const pcNumber=cleanString(body.pcNumber,40);if(!fullName)throw new Error('Full name is required.');if(category==='student'&&!pcNumber)throw new Error('PC Number is required for student records.');const preTest=cleanScore(body.preTest),postTest=cleanScore(body.postTest);if(Number.isNaN(preTest)||Number.isNaN(postTest))throw new Error('Scores must be non-negative numbers.');return {category,pcNumber,fullName,grade:category==='student'?cleanString(body.grade,80):null,section:category==='student'?cleanString(body.section,100):null,school:category==='student'?cleanString(body.school,160):null,office:category!=='student'?cleanString(body.office,160):null,position:category!=='student'?cleanString(body.position,120):null,preTest,postTest,feedback:cleanString(body.feedback,2000)};}
async function bodyJson(request){try{return await request.json();}catch{throw new Error('Request body must be valid JSON.');}}
async function requireUser(request,env){if(!env.SESSION_SECRET)return {error:'SESSION_SECRET is not configured.'};const user=await readSession(request,env.SESSION_SECRET);return user?{user}:{error:'Authentication required.'};}
export default { async fetch(request, env) {
  const url=new URL(request.url);const path=url.pathname;const method=request.method.toUpperCase();
  if(method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400'} });
  if(!path.startsWith('/api/')){
    // Serve static assets for all non-API routes
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fail('Not found.',404);
  }
  if(!env.DB)return fail('D1 binding DB is not configured.',503);
  if(path==='/api/health'&&method==='GET')return json({ok:true,service:'nextgen-smart-classroom-api',database:!!env.DB});
  if(path==='/api/login'&&method==='POST'){
    if(!env.ADMIN_USERNAME||!env.ADMIN_PASSWORD||!env.SESSION_SECRET)return fail('Admin credentials or session secret are not configured.',503);
    let body;try{body=await bodyJson(request);}catch(e){return fail(e.message);}
    const username=String(body.username||'');const password=String(body.password||'');
    if(username!==env.ADMIN_USERNAME||password!==env.ADMIN_PASSWORD)return fail('Incorrect username or password.',401);
    const token=await makeSession(username,env.SESSION_SECRET);return json({ok:true,user:{username}},200,{'Set-Cookie':cookie(token)});
  }
  if(path==='/api/logout'&&method==='POST')return json({ok:true},200,{'Set-Cookie':cookie('',0)});
  const auth=await requireUser(request,env);if(auth.error)return fail(auth.error,auth.error==='Authentication required.'?401:503);const user=auth.user;
  if(path==='/api/me'&&method==='GET')return json({ok:true,user:{username:user}});
  if(path==='/api/records'&&method==='GET'){
    const {results=[]}=await env.DB.prepare('SELECT * FROM records ORDER BY created_at DESC').all();return json({records:results.map(mapRecord)});
  }
  if(path==='/api/records'&&method==='POST'){
    let body,data;try{body=await bodyJson(request);data=normalize(body);}catch(e){return fail(e.message);}
    const id=uuid(),qrToken=uuid(),ts=now();try{await env.DB.prepare(`INSERT INTO records (id,qr_token,category,pc_number,full_name,grade,section,school,office,position,pre_test,post_test,feedback,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,qrToken,data.category,data.pcNumber,data.fullName,data.grade,data.section,data.school,data.office,data.position,data.preTest,data.postTest,data.feedback,ts,ts,user,user).run();const r=await env.DB.prepare('SELECT * FROM records WHERE id=?').bind(id).first();return json({record:mapRecord(r)},201);}catch(e){if(String(e.message).includes('UNIQUE'))return fail('That PC Number is already registered in this category.',409);return fail('Could not save the record.',500);}
  }
  const recordMatch=path.match(/^\/api\/records\/([^/]+)$/);
  
  if(recordMatch&&method==='DELETE'){
    const id=decodeURIComponent(recordMatch[1]);
    try{
      const result=await env.DB.prepare('DELETE FROM records WHERE id=?').bind(id).run();
      if(!result.meta.changes)return fail('Record not found.',404);
      return json({ok:true});
    }catch(e){return fail('Could not delete the record.',500);}
  }
if(recordMatch&&method==='PATCH'){
    const id=decodeURIComponent(recordMatch[1]);let body,data;try{body=await bodyJson(request);data=normalize(body);}catch(e){return fail(e.message);}const ts=now();try{const result=await env.DB.prepare(`UPDATE records SET category=?,pc_number=?,full_name=?,grade=?,section=?,school=?,office=?,position=?,pre_test=?,post_test=?,feedback=?,updated_at=?,updated_by=? WHERE id=?`).bind(data.category,data.pcNumber,data.fullName,data.grade,data.section,data.school,data.office,data.position,data.preTest,data.postTest,data.feedback,ts,user,id).run();if(!result.meta.changes)return fail('Record not found.',404);const r=await env.DB.prepare('SELECT * FROM records WHERE id=?').bind(id).first();return json({record:mapRecord(r)});}catch(e){if(String(e.message).includes('UNIQUE'))return fail('That PC Number is already registered in this category.',409);return fail('Could not update the record.',500);}
  }
  const scanMatch=path.match(/^\/api\/records\/([^/]+)\/scan$/);
  if(scanMatch&&method==='POST'){
    const id=decodeURIComponent(scanMatch[1]);const r=await env.DB.prepare('SELECT id FROM records WHERE id=?').bind(id).first();if(!r)return fail('Record not found.',404);let purpose='staff_lookup';try{purpose=cleanString((await bodyJson(request)).purpose,60)||purpose;}catch{}await env.DB.prepare('INSERT INTO scan_events (id,record_id,scanned_at,scanned_by,purpose) VALUES (?,?,?,?,?)').bind(uuid(),id,now(),user,purpose).run();return json({ok:true});
  }
  if(path==='/api/lookup'&&method==='GET'){
    const token=cleanString(url.searchParams.get('token'),100);if(!token)return fail('QR token is required.');const r=await env.DB.prepare('SELECT * FROM records WHERE qr_token=?').bind(token).first();if(!r)return fail('Record not found.',404);return json({record:mapRecord(r)});
  }
  return fail('Not found.',404);
} };
