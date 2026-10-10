// 怪獣群島 WILD PACT — オフライン用サービスワーカー
// index.html と同じフォルダに置く。ネットにつながった状態で一度開くと、ゲーム本体とBGMが端末に保存され、
// それ以降はホーム画面からオフラインでも遊べる。
// ・ゲーム本体（index.html）はネット優先。つながるときは毎回最新版を読み込んで保存し、つながらないときだけ保存した版を使う。
// ・BGMは保存した版を優先する。同じ名前のmp3を差し替えたときは BGM_VERSION を1つ上げる。
// ・フォントは使った文字の分だけ保存する。
const BGM_VERSION=1;
const PAGE_CACHE='wild-pact-page-v1';
const BGM_CACHE=`wild-pact-bgm-v${BGM_VERSION}`;
const FONT_CACHE='wild-pact-fonts-v1';
const KEEP=[PAGE_CACHE,BGM_CACHE,FONT_CACHE];
const SCOPE=new URL('./',self.location).href;
const PAGE_URL=new URL('./index.html',SCOPE).href;
const EXTRA=['./manifest.webmanifest','./apple-touch-icon.png','./icon-192.png'].map(p=>new URL(p,SCOPE).href);
const BGM=['BGMN1','BGMN2','BGMN3','BGMN4','BGMB1','BGMB2','BGMB3','BGMW1'].map(n=>new URL(`./paktaudio/${n}.mp3`,SCOPE).href);
// 電波が弱くて応答が来ないときは、この時間で保存した版に切り替える（最新版の受信は裏で続ける）。
const PAGE_TIMEOUT=4000;

const plain=url=>url.split(/[?#]/)[0];
const isPage=url=>{const p=plain(url);return p===SCOPE||p===PAGE_URL;};
const isBgm=url=>{const p=plain(url);return p.startsWith(SCOPE+'paktaudio/')&&p.endsWith('.mp3');};

async function storeFull(cache,url){
 const response=await fetch(url,{cache:'no-cache'});
 if(response.status===200)await cache.put(url,response);
}
async function warmBgm(){
 const cache=await caches.open(BGM_CACHE);
 for(const url of BGM){
  if(await cache.match(url,{ignoreVary:true}))continue;
  try{await storeFull(cache,url);}catch{}
 }
}

self.addEventListener('install',event=>{
 self.skipWaiting();
 event.waitUntil(caches.open(PAGE_CACHE).then(cache=>Promise.allSettled([PAGE_URL,...EXTRA].map(url=>storeFull(cache,url)))));
});

self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  for(const key of await caches.keys())if(key.startsWith('wild-pact-')&&!KEEP.includes(key))await caches.delete(key);
  await self.clients.claim();
 })());
});

// ページから届いたら、まだ保存していないBGMを1曲ずつ保存する。
self.addEventListener('message',event=>{
 if(event.data==='wild-pact:warm')event.waitUntil(warmBgm());
});

self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 if(url.origin===self.location.origin){
  if(request.mode==='navigate'||isPage(request.url)){if(isPage(request.url))page(event);return;}
  if(isBgm(request.url)){media(event);return;}
  if(EXTRA.includes(plain(request.url))){saved(event,PAGE_CACHE,true);return;}
  return;
 }
 if(url.hostname==='fonts.gstatic.com'){saved(event,FONT_CACHE,false);return;}
 if(url.hostname==='fonts.googleapis.com'){saved(event,FONT_CACHE,true);return;}
});

function page(event){
 const network=fetch(event.request).then(response=>{
  const copy=response.status===200&&response.type==='basic'&&!response.redirected?response.clone():null;
  return {response,copy};
 });
 event.waitUntil(network.then(async({copy})=>{if(copy)await(await caches.open(PAGE_CACHE)).put(PAGE_URL,copy);}).catch(()=>{}));
 event.respondWith((async()=>{
  const cached=()=>caches.open(PAGE_CACHE).then(cache=>cache.match(PAGE_URL,{ignoreVary:true}));
  try{
   const {response}=await Promise.race([network,new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),PAGE_TIMEOUT))]);
   if(response.ok||response.type==='opaqueredirect')return response;
   return (await cached())??response;
  }catch{
   const copy=await cached();
   if(copy)return copy;
   return (await network).response;
  }
 })());
}

// 音声は「〇〇バイト目から」と分けて読み込まれるので、保存した曲から必要な部分だけを切り出して返す。
function media(event){
 const request=event.request,url=plain(request.url);
 event.respondWith((async()=>{
  const cache=await caches.open(BGM_CACHE);
  const stored=await cache.match(url,{ignoreVary:true});
  if(stored)return partial(request,stored);
  // まだ保存していない曲は、今回はネットから流しつつ、裏で丸ごと保存しておく。
  event.waitUntil(storeFull(cache,url).catch(()=>{}));
  return fetch(request);
 })());
}

async function partial(request,response){
 const range=request.headers.get('range');
 if(!range)return response;
 const blob=await response.blob(),size=blob.size,type=response.headers.get('content-type')||'audio/mpeg';
 const match=/^bytes=(\d*)-(\d*)$/.exec(range.trim());
 let start=NaN,end=NaN;
 if(match&&match[1]!==''){start=Number(match[1]);end=match[2]===''?size-1:Math.min(Number(match[2]),size-1);}
 else if(match&&match[2]!==''){start=Math.max(0,size-Number(match[2]));end=size-1;}
 if(!(start>=0&&start<=end&&start<size))return new Response(null,{status:416,statusText:'Range Not Satisfiable',headers:{'Content-Range':`bytes */${size}`}});
 return new Response(blob.slice(start,end+1,type),{status:206,statusText:'Partial Content',headers:{'Content-Type':type,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes'}});
}

// 保存した版を優先して返す。refresh なら裏で最新版を取りに行き、次回に備えて入れ替える。
function saved(event,cacheName,refresh){
 const request=event.request;
 event.respondWith((async()=>{
  const cache=await caches.open(cacheName);
  const stored=await cache.match(request,{ignoreVary:true});
  const load=()=>fetch(request).then(response=>{
   if(response.ok||response.type==='opaque'){const copy=response.clone();return cache.put(request,copy).then(()=>response,()=>response);}
   return response;
  });
  if(stored){if(refresh)event.waitUntil(load().catch(()=>{}));return stored;}
  return load();
 })());
}
