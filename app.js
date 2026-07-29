/* iPAS 融合行動課本｜Supabase 版 */
(() => {
  'use strict';
  const cfg = window.IPAS_CONFIG || {};
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const configured = /^https:\/\/.+\.supabase\.co$/.test(cfg.supabaseUrl || '') && !String(cfg.supabaseKey || '').startsWith('PASTE_');
  let sb = null, session = null, profile = null, ROOT = null;
  let allNodes = [], allSections = [], sectionByNode = new Map();
  let personalContent = new Map(), nodeState = new Map();
  let expanded = new Set(['root','part-1','part-2']), scale = 1, currentNode = null, personalEdit = false;
  let adminCurrentNode = null, adminCurrentSection = null;
  const imageUrlCache = new Map();
  const saveTimers = new Map();

  function setSync(text, bad=false){ if($('syncStatus')){ $('syncStatus').textContent=text; $('syncStatus').classList.toggle('danger',bad); } }
  function show(el, on=true){ el?.classList.toggle('hidden', !on); }
  function uuid(prefix='n'){ return `${prefix}-${crypto.randomUUID()}`; }
  function textFromHtml(html=''){ const d=document.createElement('div'); d.innerHTML=html; return d.textContent.replace(/\s+/g,' ').trim(); }
  function isAdmin(){ return profile?.role === 'admin'; }

  async function loadSupabaseLibrary(){
    if(window.supabase?.createClient)return;
    await new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.onload=resolve;
      script.onerror=()=>reject(new Error('無法載入 Supabase 程式庫，請檢查網路連線。'));
      document.head.appendChild(script);
    });
  }

  async function init(){
    $('appTitle').textContent = cfg.appTitle || '玥鳴的 iPAS 融合行動課本';
    if(cfg.learningSheetUrl){ $('sheetLink').href=cfg.learningSheetUrl; } else show($('sheetLink'),false);
    if(!configured){ show($('setupNotice'),true); show($('authScreen'),true); $('authMessage').textContent='請先設定 config.js，再重新部署一次。'; return; }
    await loadSupabaseLibrary();
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const {data:{session:s}} = await sb.auth.getSession(); session=s;
    bindStaticEvents();
    sb.auth.onAuthStateChange(async (_event,sess)=>{ session=sess; await routeAuth(); });
    await routeAuth();
  }

  async function routeAuth(){
    if(!session){ show($('authScreen'),true); show($('app'),false); return; }
    show($('authScreen'),false); show($('app'),true);
    await loadProfile();
    $('accountEmail').textContent=session.user.email || '';
    $('roleBadge').textContent=isAdmin()?'管理者':'閱讀者';
    show($('adminBtn'),isAdmin());
    await loadAllData();
  }

  async function loadProfile(){
    const {data,error}=await sb.from('profiles').select('id,email,role').eq('id',session.user.id).single();
    if(error) throw new Error(`讀取使用者權限失敗：${error.message}`);
    profile=data;
  }

  async function loadAllData(){
    setSync('同步資料中…');
    const [nRes,sRes,pRes,stRes] = await Promise.all([
      sb.from('textbook_nodes').select('*').order('sort_order',{ascending:true}),
      sb.from('content_sections').select('*').order('sort_order',{ascending:true}),
      sb.from('user_content').select('*').eq('user_id',session.user.id),
      sb.from('user_node_state').select('*').eq('user_id',session.user.id)
    ]);
    for(const r of [nRes,sRes,pRes,stRes]) if(r.error) throw new Error(r.error.message);
    allNodes=nRes.data||[]; allSections=sRes.data||[];
    personalContent=new Map((pRes.data||[]).map(x=>[x.section_id,x]));
    nodeState=new Map((stRes.data||[]).map(x=>[x.node_id,x]));
    buildTree(); renderTree(); populateAdminSelectors();
    show($('firstRunPanel'),isAdmin() && allNodes.length===0);
    setSync(`已同步 ${allNodes.length} 個節點`);
  }

  function buildTree(){
    const map=new Map(allNodes.map(n=>[n.id,{...n,children:[],sections:[]}])) ;
    for(const s of allSections){ const n=map.get(s.node_id); if(n) n.sections.push(s); }
    sectionByNode=new Map([...map.values()].map(n=>[n.id,n.sections]));
    for(const n of map.values()){
      n.sections.sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
      if(n.parent_id && map.has(n.parent_id)) map.get(n.parent_id).children.push(n);
    }
    for(const n of map.values()) n.children.sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
    ROOT=map.get('root') || [...map.values()].find(n=>!n.parent_id) || null;
  }

  function flatten(n,out=[]){ if(!n)return out; out.push(n); for(const c of n.children||[]) flatten(c,out); return out; }
  function hasReadable(n){ return !!((n.sections||[]).length || (n.children||[]).some(hasReadable)); }
  function collectSections(n,out=[]){ (n.sections||[]).forEach(s=>out.push({node:n,section:s})); (n.children||[]).forEach(c=>collectSections(c,out)); return out; }
  function findNode(id,n=ROOT){ if(!n)return null; if(n.id===id)return n; for(const c of n.children||[]){ const r=findNode(id,c); if(r)return r; } return null; }
  function summary(n){ return n.summary || n.sections?.[0]?.canonical_text?.slice(0,110) || ''; }

  function renderNode(n){
    const kids=n.children||[], open=expanded.has(n.id), state=nodeState.get(n.id)?.status||'';
    return `<div class="treeItem kind-${esc(n.kind||'concept')}" data-node-id="${esc(n.id)}"><article class="node ${esc(n.kind||'')}"><div class="nodeTop"><button class="expand ${kids.length?'':'noKids'}" data-expand="${esc(n.id)}" type="button">${open?'−':'＋'}</button><div><div class="code">${esc(n.code)}</div><div class="title">${esc(n.title)}</div><div class="summary">${esc(summary(n))}</div></div></div><div class="nodeBottom"><button class="read" data-read="${esc(n.id)}" ${hasReadable(n)?'':'disabled'} type="button">閱讀完整內容</button>${isAdmin()?`<button class="manageNode" data-manage="${esc(n.id)}" type="button">管理</button>`:''}<span class="markState">${esc(state)}</span></div></article>${kids.length&&open?`<div class="bridge"><div class="stack">${kids.map(renderNode).join('')}</div></div>`:''}</div>`;
  }
  function renderTree(){
    if(!ROOT){ $('canvas').innerHTML='<div class="empty">資料庫尚未匯入課本內容。管理者請開啟「內容管理」。</div>'; return; }
    $('canvas').innerHTML=renderNode(ROOT); $('canvas').style.transform=`scale(${scale})`; bindTreeEvents();
  }
  function bindTreeEvents(){
    document.querySelectorAll('[data-expand]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();expanded.has(b.dataset.expand)?expanded.delete(b.dataset.expand):expanded.add(b.dataset.expand);renderTree();}));
    document.querySelectorAll('[data-read]').forEach(b=>b.addEventListener('click',()=>{if(!b.disabled)openNode(b.dataset.read)}));
    document.querySelectorAll('[data-manage]').forEach(b=>b.addEventListener('click',()=>openAdmin(b.dataset.manage)));
  }

  async function openNode(id){ currentNode=findNode(id); if(!currentNode)return; $('dcode').textContent=currentNode.code||''; $('dtitle').textContent=currentNode.title; $('dmeta').textContent=`本節含 ${collectSections(currentNode,[]).length} 個內容區段`; $('drawer').classList.add('open'); $('backdrop').classList.add('open'); personalEdit=false; $('togglePersonalEdit').classList.remove('active'); $('togglePersonalEdit').textContent='開始個人編輯'; await renderDrawer(); }
  async function renderDrawer(){
    if(!currentNode)return;
    const rows=collectSections(currentNode,[]);
    const blocks=[];
    for(const {node,section} of rows){
      const personal=personalContent.get(section.id); const html=personal?.edited_html || section.canonical_html || '';
      let image='';
      if(section.image_path){ const url=await getImageUrl(section.image_path); if(url) image=`<div class="pageImage"><img src="${esc(url)}" alt="${esc(section.title)}" data-image="${esc(url)}"></div>`; }
      blocks.push(`<section class="section"><div class="sectionHead"><div class="sectionTitle">${esc(node.code?node.code+'｜':'')}${esc(section.title)}</div><span class="sourceBadge ${esc(section.source_type||'')}">${esc(section.source)}</span></div><div class="editable" data-section="${esc(section.id)}" contenteditable="${personalEdit}">${html}</div>${image}</section>`);
    }
    const state=nodeState.get(currentNode.id)||{};
    $('drawerBody').innerHTML=`<div class="stateRow"><label><input type="radio" name="state" value="已讀" ${state.status==='已讀'?'checked':''}> 已讀</label><label><input type="radio" name="state" value="待複習" ${state.status==='待複習'?'checked':''}> 待複習</label><label><input type="radio" name="state" value="已掌握" ${state.status==='已掌握'?'checked':''}> 已掌握</label></div>${blocks.join('')||'<div class="empty">沒有可閱讀內容。</div>'}<h3>我的筆記</h3><textarea class="personalNote" id="personalNote" placeholder="寫下自己的理解、口訣或錯題提醒">${esc(state.note||'')}</textarea>`;
    document.querySelectorAll('input[name=state]').forEach(r=>r.addEventListener('change',()=>saveNodeState({status:r.value})));
    $('personalNote').addEventListener('input',()=>debounce('node-note',()=>saveNodeState({note:$('personalNote').value}),450));
    document.querySelectorAll('[data-image]').forEach(img=>img.addEventListener('click',()=>openImage(img.dataset.image)));
    if(personalEdit) bindPersonalEditors();
  }
  async function getImageUrl(path){
    if(path.startsWith('data:')||path.startsWith('http')) return path;
    if(imageUrlCache.has(path))return imageUrlCache.get(path);
    const {data,error}=await sb.storage.from('textbook-assets').createSignedUrl(path,3600);
    if(error)return ''; imageUrlCache.set(path,data.signedUrl); return data.signedUrl;
  }
  function bindPersonalEditors(){
    document.querySelectorAll('.editable').forEach(el=>el.addEventListener('input',()=>debounce(`section-${el.dataset.section}`,()=>savePersonalSection(el.dataset.section,el.innerHTML),450)));
  }
  async function savePersonalSection(sectionId,html){
    setSync('儲存個人修改中…');
    const payload={user_id:session.user.id,section_id:sectionId,edited_html:html,updated_at:new Date().toISOString()};
    const {data,error}=await sb.from('user_content').upsert(payload,{onConflict:'user_id,section_id'}).select().single();
    if(error){setSync('個人修改儲存失敗',true);return;} personalContent.set(sectionId,data);setSync('個人修改已同步');
  }
  async function saveNodeState(patch){
    const old=nodeState.get(currentNode.id)||{}; const payload={user_id:session.user.id,node_id:currentNode.id,status:patch.status??old.status??'',note:patch.note??old.note??'',is_completed:patch.is_completed??old.is_completed??false,updated_at:new Date().toISOString()};
    const {data,error}=await sb.from('user_node_state').upsert(payload,{onConflict:'user_id,node_id'}).select().single();
    if(error){setSync('學習紀錄儲存失敗',true);return;} nodeState.set(currentNode.id,data); setSync('學習紀錄已同步'); renderTree();
  }
  function debounce(key,fn,ms){ clearTimeout(saveTimers.get(key)); saveTimers.set(key,setTimeout(fn,ms)); }
  function formatSelection(cmd,val=null){
    if(!personalEdit){alert('請先按「開始個人編輯」');return;}
    document.execCommand(cmd,false,val);
    const sel=document.getSelection(); const el=sel?.anchorNode?.parentElement?.closest('.editable'); if(el) savePersonalSection(el.dataset.section,el.innerHTML);
  }

  function search(q){
    q=q.trim().toLowerCase(); const box=$('searchResults'); if(!q){box.classList.remove('open');return;}
    const rows=flatten(ROOT,[]).filter(n=>{const texts=[n.title,n.code,n.summary,...(n.sections||[]).map(s=>s.canonical_text)].join(' ').toLowerCase();return texts.includes(q)}).slice(0,50);
    box.innerHTML=rows.map(n=>`<button class="result" data-result="${esc(n.id)}"><b>${esc(n.code)} ${esc(n.title)}</b><br><small>${esc(summary(n).slice(0,100))}</small></button>`).join('')||'<div class="empty">找不到結果</div>'; box.classList.add('open'); box.querySelectorAll('[data-result]').forEach(b=>b.addEventListener('click',()=>{reveal(b.dataset.result);box.classList.remove('open')}));
  }
  function reveal(id){ function rec(n,path=[]){if(n.id===id){path.forEach(x=>expanded.add(x));return true}for(const c of n.children||[])if(rec(c,[...path,n.id]))return true;return false} if(ROOT)rec(ROOT);renderTree();setTimeout(()=>document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.scrollIntoView({behavior:'smooth',block:'center',inline:'center'}),70); }
  function zoom(delta){scale=Math.max(.38,Math.min(1.8,scale+delta));$('canvas').style.transform=`scale(${scale})`;$('zoomReset').textContent=`${Math.round(scale*100)}%`;}
  function fitCanvas(){const v=$('viewport'),c=$('canvas'); if(!c.scrollWidth)return; scale=Math.max(.38,Math.min(1,(v.clientWidth-60)/c.scrollWidth));zoom(0);v.scrollTo({left:0,top:0,behavior:'smooth'});}
  function bindPan(){let dragging=false,sx=0,sy=0,sl=0,st=0;const v=$('viewport');v.addEventListener('pointerdown',e=>{if(e.target.closest('button,input,select,textarea,.node'))return;dragging=true;sx=e.clientX;sy=e.clientY;sl=v.scrollLeft;st=v.scrollTop;v.classList.add('dragging');v.setPointerCapture(e.pointerId)});v.addEventListener('pointermove',e=>{if(!dragging)return;v.scrollLeft=sl-(e.clientX-sx);v.scrollTop=st-(e.clientY-sy)});v.addEventListener('pointerup',()=>{dragging=false;v.classList.remove('dragging')});v.addEventListener('wheel',e=>{if(e.ctrlKey){e.preventDefault();zoom(e.deltaY<0?.08:-.08)}},{passive:false});}
  function openImage(src){$('imageModalImg').src=src;$('imageModal').classList.add('open');$('imageModal').setAttribute('aria-hidden','false')}

  function populateJump(){ const chapters=flatten(ROOT,[]).filter(n=>n.kind==='chapter'); $('jump').innerHTML='<option value="">跳到章節</option>'+chapters.map(n=>`<option value="${esc(n.id)}">${esc(n.code)} ${esc(n.title)}</option>`).join(''); }
  function populateAdminSelectors(){
    populateJump(); if(!isAdmin())return;
    const opts=allNodes.slice().sort((a,b)=>(a.code||'').localeCompare(b.code||'','zh-Hant',{numeric:true})).map(n=>`<option value="${esc(n.id)}">${esc(n.code)}｜${esc(n.title)}</option>`).join(''); $('adminNodeSelect').innerHTML=opts; if(allNodes.length){loadAdminNode(allNodes[0].id)}
  }
  function loadAdminNode(id){
    adminCurrentNode=allNodes.find(n=>n.id===id)||null;if(!adminCurrentNode)return;
    $('adminNodeSelect').value=id;$('nodeCode').value=adminCurrentNode.code||'';$('nodeTitle').value=adminCurrentNode.title||'';$('nodeKind').value=adminCurrentNode.kind||'concept';$('nodeSort').value=adminCurrentNode.sort_order??0;$('nodeSummary').value=adminCurrentNode.summary||'';$('nodePublished').checked=adminCurrentNode.is_published!==false;
    const ss=allSections.filter(s=>s.node_id===id).sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));$('adminSectionSelect').innerHTML=ss.map(s=>`<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')+'<option value="__new__">＋新增內容區段</option>'; if(ss.length)loadAdminSection(ss[0].id);else loadAdminSection('__new__');
  }
  function loadAdminSection(id){
    adminCurrentSection=id==='__new__'?null:allSections.find(s=>s.id===id)||null; $('adminSectionSelect').value=id;
    const s=adminCurrentSection||{};$('sectionTitle').value=s.title||'';$('sectionSource').value=s.source||'';$('sectionSourceType').value=s.source_type||'textbook';$('sectionSort').value=s.sort_order??0;$('sectionHtml').value=s.canonical_html||'';$('sectionText').value=s.canonical_text||'';$('sectionVerification').value=s.verification||'';$('sectionPublished').checked=s.is_published!==false;$('sectionImagePath').textContent=s.image_path||'尚未上傳圖片';
  }
  function openAdmin(nodeId=null){if(!isAdmin())return; if(nodeId)loadAdminNode(nodeId);$('adminPanel').classList.add('open');$('adminBackdrop').classList.add('open');show($('firstRunPanel'),allNodes.length===0);}
  async function saveAdminNode(){
    const n=adminCurrentNode;if(!n)return;const payload={id:n.id,parent_id:n.parent_id,code:$('nodeCode').value.trim(),title:$('nodeTitle').value.trim(),kind:$('nodeKind').value,summary:$('nodeSummary').value.trim(),sort_order:Number($('nodeSort').value||0),is_published:$('nodePublished').checked,version:n.version||'',updated_at:new Date().toISOString()};const {error}=await sb.from('textbook_nodes').upsert(payload);if(error)return alert(error.message);await loadAllData();loadAdminNode(n.id);alert('節點已儲存');
  }
  async function addChildNode(){
    if(!adminCurrentNode)return;const id=uuid('n');const payload={id,parent_id:adminCurrentNode.id,code:'新節點',title:'未命名節點',kind:'concept',summary:'',sort_order:(adminCurrentNode.children?.length||0)+1,is_published:false};const {error}=await sb.from('textbook_nodes').insert(payload);if(error)return alert(error.message);await loadAllData();loadAdminNode(id);alert('已新增子節點，請修改內容後發布。');
  }
  async function saveAdminSection(){
    if(!adminCurrentNode)return;const id=adminCurrentSection?.id||uuid('s');const payload={id,node_id:adminCurrentNode.id,title:$('sectionTitle').value.trim()||'未命名內容',source:$('sectionSource').value.trim(),source_type:$('sectionSourceType').value,canonical_html:$('sectionHtml').value,canonical_text:$('sectionText').value.trim()||textFromHtml($('sectionHtml').value),image_path:adminCurrentSection?.image_path||null,verification:$('sectionVerification').value.trim(),sort_order:Number($('sectionSort').value||0),is_published:$('sectionPublished').checked,updated_at:new Date().toISOString()};const {error}=await sb.from('content_sections').upsert(payload);if(error)return alert(error.message);await loadAllData();loadAdminNode(adminCurrentNode.id);loadAdminSection(id);alert('內容已儲存');
  }
  async function uploadSectionFile(){
    const file=$('sectionImageFile').files[0];if(!file)return alert('請先選擇檔案');if(!adminCurrentNode)return;const sectionId=adminCurrentSection?.id||uuid('s');if(!adminCurrentSection){await saveAdminSection();adminCurrentSection=allSections.find(s=>s.node_id===adminCurrentNode.id&&s.title===$('sectionTitle').value.trim())||null;}const ext=file.name.split('.').pop()||'bin';const path=`sections/${sectionId}/${Date.now()}.${ext}`;const {error}=await sb.storage.from('textbook-assets').upload(path,file,{upsert:true,contentType:file.type});if(error)return alert(error.message);const targetId=adminCurrentSection?.id||sectionId;await sb.from('content_sections').update({image_path:path}).eq('id',targetId);imageUrlCache.delete(path);await loadAllData();loadAdminNode(adminCurrentNode.id);loadAdminSection(targetId);alert('檔案已上傳');
  }
  async function saveSourceImport(){
    const file=$('sourceFile').files[0];if(!file)return alert('請選擇照片或 PDF');const ext=file.name.split('.').pop()||'bin';const path=`imports/${session.user.id}/${Date.now()}-${file.name.replace(/[^\w.\-\u4e00-\u9fff]/g,'_')}`;let r=await sb.storage.from('textbook-assets').upload(path,file,{contentType:file.type});if(r.error)return $('sourceImportMessage').textContent=r.error.message;r=await sb.from('source_imports').insert({user_id:session.user.id,file_name:file.name,source_label:$('importSourceLabel').value.trim(),chapter_hint:$('importChapterHint').value.trim(),page_range:$('importPageRange').value.trim(),storage_path:path,status:'pending'});$('sourceImportMessage').textContent=r.error?r.error.message:'已存入暫存區。';
  }

  function flattenSeed(root){
    const nodes=[],sections=[];function walk(n,parent=null,order=0){nodes.push({id:n.id,parent_id:parent,code:n.code||'',title:n.title||'',kind:n.kind||'concept',summary:n.summary||'',sort_order:order,is_published:true,version:root.version||''});(n.sections||[]).forEach((s,i)=>sections.push({id:s.id,node_id:n.id,title:s.title||n.title||'',source:s.source||'',source_type:s.sourceType||'personal',canonical_html:s.canonicalHtml||'',canonical_text:s.canonicalText||textFromHtml(s.canonicalHtml||''),image_path:s.image||null,verification:s.verification||'',sort_order:i,is_published:true}));(n.children||[]).forEach((c,i)=>walk(c,n.id,i));}walk(root,null,0);return{nodes,sections};
  }
  async function dataUriToUpload(section){
    if(!section.image_path?.startsWith('data:'))return section;const [head,b64]=section.image_path.split(',');const mime=(head.match(/data:([^;]+)/)||[])[1]||'image/jpeg';const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const ext=mime.split('/')[1]?.replace('jpeg','jpg')||'bin';const path=`seed/${section.id}.${ext}`;const {error}=await sb.storage.from('textbook-assets').upload(path,new Blob([bytes],{type:mime}),{upsert:true,contentType:mime});if(error)throw error;return{...section,image_path:path};
  }
  async function importUpdatePackage(){
    const file=$('updatePackageFile').files[0]; if(!file)return alert('請先選擇 JSON 更新包');
    $('updatePackageMessage').textContent='讀取更新包…'; $('updatePackageProgress').value=3;
    try{
      let pkg=JSON.parse(await file.text());
      if(pkg.root) pkg=flattenSeed(pkg.root); else if(pkg.id && pkg.children) pkg=flattenSeed(pkg);
      if(!Array.isArray(pkg.nodes)||!Array.isArray(pkg.sections)) throw new Error('格式必須包含 nodes 與 sections 陣列');
      for(let i=0;i<pkg.sections.length;i++){
        const s=pkg.sections[i];
        if(s.image && !s.image_path) s.image_path=s.image;
        if(s.sourceType && !s.source_type) s.source_type=s.sourceType;
        if(s.canonicalHtml && !s.canonical_html) s.canonical_html=s.canonicalHtml;
        if(s.canonicalText && !s.canonical_text) s.canonical_text=s.canonicalText;
        if(s.image_path?.startsWith('data:')) pkg.sections[i]=await dataUriToUpload(s);
        $('updatePackageProgress').value=3+Math.round((i/Math.max(1,pkg.sections.length))*27);
      }
      for(let i=0;i<pkg.nodes.length;i+=100){const {error}=await sb.from('textbook_nodes').upsert(pkg.nodes.slice(i,i+100));if(error)throw error;$('updatePackageProgress').value=30+Math.round((i/Math.max(1,pkg.nodes.length))*30)}
      for(let i=0;i<pkg.sections.length;i+=75){const {error}=await sb.from('content_sections').upsert(pkg.sections.slice(i,i+75));if(error)throw error;$('updatePackageProgress').value=60+Math.round((i/Math.max(1,pkg.sections.length))*39)}
      $('updatePackageProgress').value=100; $('updatePackageMessage').textContent=`更新完成：${pkg.nodes.length} 個節點、${pkg.sections.length} 個內容區段。`; await loadAllData();
    }catch(e){$('updatePackageMessage').textContent=`匯入失敗：${e.message}`;$('updatePackageMessage').classList.add('danger')}
  }

  async function importSeed(){
    if(!isAdmin())return; if(allNodes.length && !confirm('資料庫已有內容，確定要依穩定 ID 更新嗎？不會刪除個人標註。'))return;
    $('importMessage').textContent='讀取原始資料…';$('importProgress').value=2;
    try{const seed=await fetch('seed/content.json').then(r=>{if(!r.ok)throw new Error('找不到 seed/content.json');return r.json()});const flat=flattenSeed(seed);for(let i=0;i<flat.sections.length;i++){if(flat.sections[i].image_path?.startsWith('data:'))flat.sections[i]=await dataUriToUpload(flat.sections[i]);$('importProgress').value=2+Math.round((i/flat.sections.length)*28)}for(let i=0;i<flat.nodes.length;i+=100){const {error}=await sb.from('textbook_nodes').upsert(flat.nodes.slice(i,i+100));if(error)throw error;$('importProgress').value=30+Math.round((i/flat.nodes.length)*30)}for(let i=0;i<flat.sections.length;i+=75){const {error}=await sb.from('content_sections').upsert(flat.sections.slice(i,i+75));if(error)throw error;$('importProgress').value=60+Math.round((i/flat.sections.length)*38)}$('importProgress').value=100;$('importMessage').textContent=`匯入完成：${flat.nodes.length} 個節點、${flat.sections.length} 個內容區段。`;await loadAllData();}catch(e){$('importMessage').textContent=`匯入失敗：${e.message}`;$('importMessage').classList.add('danger')}
  }

  function bindStaticEvents(){
    $('signInBtn').onclick=async()=>{const {error}=await sb.auth.signInWithPassword({email:$('authEmail').value.trim(),password:$('authPassword').value});$('authMessage').textContent=error?error.message:'登入成功';};
    $('signUpBtn').onclick=async()=>{const {data,error}=await sb.auth.signUp({email:$('authEmail').value.trim(),password:$('authPassword').value});$('authMessage').textContent=error?error.message:(data.session?'帳號已建立並登入。':'帳號已建立，請到信箱完成驗證後登入。');};
    $('signOutBtn').onclick=()=>sb.auth.signOut();$('search').addEventListener('input',()=>search($('search').value));$('jump').onchange=()=>{if($('jump').value)reveal($('jump').value)};$('expandAll').onclick=()=>{flatten(ROOT,[]).forEach(n=>{if(n.children?.length)expanded.add(n.id)});renderTree()};$('collapseAll').onclick=()=>{expanded=new Set(['root','part-1','part-2']);renderTree()};$('zoomIn').onclick=()=>zoom(.1);$('zoomOut').onclick=()=>zoom(-.1);$('zoomReset').onclick=()=>{scale=1;zoom(0)};$('fitBtn').onclick=fitCanvas;$('closeDrawer').onclick=()=>{$('drawer').classList.remove('open');$('backdrop').classList.remove('open')};$('backdrop').onclick=$('closeDrawer').onclick;$('togglePersonalEdit').onclick=async()=>{personalEdit=!personalEdit;$('togglePersonalEdit').classList.toggle('active',personalEdit);$('togglePersonalEdit').textContent=personalEdit?'結束個人編輯':'開始個人編輯';$('editStatus').textContent=personalEdit?'修改與畫重點會同步到資料庫':'閱讀模式';await renderDrawer()};document.querySelectorAll('[data-format]').forEach(b=>b.onclick=()=>formatSelection(b.dataset.format,b.dataset.value||null));$('clearFormat').onclick=()=>formatSelection('removeFormat');$('resetPersonal').onclick=async()=>{if(!currentNode||!confirm('清除本節及所有子節的個人文字修改與畫重點？'))return;const ids=collectSections(currentNode,[]).map(x=>x.section.id);for(let i=0;i<ids.length;i+=100){await sb.from('user_content').delete().eq('user_id',session.user.id).in('section_id',ids.slice(i,i+100))}ids.forEach(id=>personalContent.delete(id));await renderDrawer();setSync('個人修改已還原')};$('imageModal').onclick=e=>{if(e.target.id==='imageModal'||e.target.id==='imageClose'){$('imageModal').classList.remove('open');$('imageModal').setAttribute('aria-hidden','true')}};$('adminBtn').onclick=()=>openAdmin();$('closeAdmin').onclick=()=>{$('adminPanel').classList.remove('open');$('adminBackdrop').classList.remove('open')};$('adminBackdrop').onclick=$('closeAdmin').onclick;$('adminNodeSelect').onchange=()=>loadAdminNode($('adminNodeSelect').value);$('adminSectionSelect').onchange=()=>loadAdminSection($('adminSectionSelect').value);$('saveNodeBtn').onclick=saveAdminNode;$('addChildBtn').onclick=addChildNode;$('saveSectionBtn').onclick=saveAdminSection;$('addSectionBtn').onclick=()=>loadAdminSection('__new__');$('uploadImageBtn').onclick=uploadSectionFile;$('saveSourceImportBtn').onclick=saveSourceImport;$('importSeedBtn').onclick=importSeed;$('importUpdatePackageBtn').onclick=importUpdatePackage;bindPan();
  }

  init().catch(e=>{console.error(e);show($('authScreen'),true);$('authMessage').textContent=`網站啟動失敗：${e.message}`;setSync('啟動失敗',true)});
})();
