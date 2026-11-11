/* ZEPE TECH : scripts de la page dashboard (fichier externe, car les scripts écrits dans la page peuvent être bloqués par la politique de sécurité du serveur). */

/* Choix du serveur + compteur de slots dans la fenêtre « Déployer un bot ».
   - Les serveurs viennent de GET /api/servers (tableau de {id,name,online,active,max,host,created}).
   - Si cette route n'existe pas encore, la liste de secours ci-dessous est utilisée.
   - Le serveur choisi est dans window.zepeServerId et dans l'input caché #serverId. */
(function(){
  var FALLBACK=[{id:'zepe-1',name:'Zepe Serveur 1',online:true,active:0,max:50,host:'Zepe Tech',created:'10/11/2026'}];
  var list=document.getElementById('srvList'),hid=document.getElementById('serverId');
  window.zepeServerId='';

  function pick(s,el){
    if(!s.online||s.active>=s.max)return;
    var all=list.querySelectorAll('.srv');
    for(var i=0;i<all.length;i++){all[i].classList.remove('sel');all[i].setAttribute('aria-checked','false');}
    el.classList.add('sel');el.setAttribute('aria-checked','true');
    hid.value=s.id;window.zepeServerId=s.id;
  }
  function mk(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;}
  function render(servers){
    list.textContent='';
    var first=null;
    servers.forEach(function(s){
      var full=s.active>=s.max,el=mk('button','srv'+(full||!s.online?' full':''));
      el.type='button';el.setAttribute('role','radio');el.setAttribute('aria-checked','false');
      var top=mk('div','top'),left=mk('div');
      left.appendChild(mk('div','nm',s.name));
      left.appendChild(mk('div','st'+(s.online?'':' offl'),(s.online?'● en ligne':'● hors ligne')));
      top.appendChild(left);top.appendChild(mk('span','cap',s.active+'/'+s.max+' actifs'));
      el.appendChild(top);
      var meta=[];if(s.host)meta.push('Hébergé par '+s.host);if(s.created)meta.push('Créé le '+s.created);
      if(meta.length)el.appendChild(mk('div','meta',meta.join(' · ')));
      el.addEventListener('click',function(){pick(s,el);});
      list.appendChild(el);
      if(!first&&s.online&&!full)first={s:s,el:el};
    });
    if(first)pick(first.s,first.el);
  }
  fetch('/api/servers',{credentials:'same-origin'})
    .then(function(r){return r.ok?r.json():Promise.reject();})
    .then(function(d){render(Array.isArray(d)&&d.length?d:FALLBACK);})
    .catch(function(){render(FALLBACK);});

  /* Compteur de slots : suit la valeur déjà affichée dans #sSlots par dash.js */
  var src=document.getElementById('sSlots'),note=document.getElementById('slotNote'),
      cnt=document.getElementById('slotNoteCnt'),sub=document.getElementById('slotNoteSub'),
      buy=document.getElementById('slotNoteBuy');
  function sync(){
    var n=parseInt(src.textContent,10)||0;
    if(n>0){note.classList.remove('none');cnt.textContent=n+' dispo';sub.textContent='Un slot sera utilisé pour ce bot.';buy.classList.add('off');}
    else{note.classList.add('none');cnt.textContent='0 slot';sub.textContent='Il faut un slot actif pour faire tourner un bot.';buy.classList.remove('off');}
  }
  new MutationObserver(sync).observe(src,{childList:true,characterData:true,subtree:true});
  sync();
  buy.addEventListener('click',function(){var b=document.getElementById('buySlot');if(b)b.click();});
})();

/* Fenêtre Premium. Modifie CFG pour changer prix, durées et avantages.
   Le bouton Payer appelle POST /api/premium/checkout {days, phone} et attend {url} en réponse
   (lien de paiement). Tant que cette route n'existe pas, un message est affiché. */
(function(){
  var CFG={
    currency:'GNF',
    payNumber:'224610888616',   /* numéro qui reçoit les paiements */
    payMethod:'Mobile Money',   /* ex. : Orange Money, MTN MoMo */
    /* Packs de coins : à adapter à tes prix (price en GNF) */
    plans:[{coins:100,price:10000},{coins:300,price:25000},{coins:1000,price:75000}],
    perkTitle:'À quoi servent les coins ?',
    perks:['Acheter un slot pour connecter ton bot','Garder ton bot en ligne sur nos serveurs','Les coins sont crédités après vérification du paiement'],
    foot:'Coins crédités après vérification du paiement'
  };
  var $=function(id){return document.getElementById(id);};
  var modal=$('premModal'),durs=$('durs'),sel=CFG.plans[0],opener=null;
  function money(n){return n.toLocaleString('fr-FR')+' '+CFG.currency;}
  function say(t){var el=$('toast');if(!el)return;el.textContent=t;el.classList.add('show');setTimeout(function(){el.classList.remove('show');},3000);}
  function paint(){
    var bs=durs.querySelectorAll('button');
    for(var i=0;i<bs.length;i++){var on=CFG.plans[i]===sel;bs[i].classList.toggle('sel',on);bs[i].setAttribute('aria-checked',on?'true':'false');}
    $('pDur').textContent=sel.coins+' coins';$('pAmt').textContent=money(sel.price);
  }
  $('perkTitle').textContent=CFG.perkTitle;$('premFoot').textContent=CFG.foot;
  CFG.perks.forEach(function(p){var li=document.createElement('li');li.textContent=p;$('perkList').appendChild(li);});
  CFG.plans.forEach(function(p){
    var b=document.createElement('button');b.type='button';b.setAttribute('role','radio');b.textContent=p.coins+' coins';
    b.addEventListener('click',function(){sel=p;paint();});durs.appendChild(b);
  });
  paint();
  function steps(two){$('payStep1').classList.toggle('off',two);$('payStep2').classList.toggle('off',!two);}
  function open(){opener=document.activeElement;steps(false);modal.classList.remove('off');$('premClose').focus();}
  function close(){modal.classList.add('off');if(opener&&opener.focus)opener.focus();}
  $('showPremium').addEventListener('click',open);
  $('premClose').addEventListener('click',close);
  modal.addEventListener('click',function(e){if(e.target===modal)close();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!modal.classList.contains('off'))close();});
  var cust='';
  $('premNext').addEventListener('click',function(){
    var d=$('premPhone').value.replace(/\D/g,'').replace(/^0+/,'');
    if(d.length<6||d.length>12){say('Numéro invalide.');return;}
    cust=$('premCc').value+d;
    $('payAmt').textContent=money(sel.price);$('payMethod').textContent=CFG.payMethod;$('payNum').textContent='+'+CFG.payNumber;
    steps(true);$('payRef').focus();
  });
  $('payBack').addEventListener('click',function(){steps(false);});
  $('payCopy').addEventListener('click',function(){
    if(navigator.clipboard){navigator.clipboard.writeText(CFG.payNumber).then(function(){say('Numéro copié.');},function(){say('Copie impossible.');});}
  });
  $('premPay').addEventListener('click',function(){
    var ref=$('payRef').value.trim();
    if(ref.length<4){say('Saisis la référence de la transaction.');return;}
    var btn=$('premPay');btn.disabled=true;
    fetch('/api/premium/request',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({coins:sel.coins,phone:cust,reference:ref})})
      .then(function(r){return r.ok?Promise.resolve():Promise.reject();})
      .then(function(){say('Demande envoyée. Tes coins arrivent après vérification.');$('payRef').value='';close();})
      .catch(function(){say('Envoi impossible pour le moment.');})
      .then(function(){btn.disabled=false;});
  });
})();

/* Statistiques, activité récente, bannière coins.
   Routes attendues (facultatives, sinon les valeurs restent à « – ») :
   GET /api/stats    -> {oldestUptimeHours, botsOnline, publicServers, users}
   GET /api/activity -> [{icon, text, at}]  (at = date ISO) */
(function(){
  var $=function(id){return document.getElementById(id);};
  function set(id,v){var e=$(id);if(e&&v!==undefined&&v!==null)e.textContent=v;}
  var bc=$('botCount');
  function mirror(){set('stBots',(bc.textContent||'').trim()||'0');}
  new MutationObserver(mirror).observe(bc,{childList:true,characterData:true,subtree:true});mirror();
  function get(u){return fetch(u,{credentials:'same-origin'}).then(function(r){return r.ok?r.json():Promise.reject();});}
  get('/api/stats').then(function(d){
    if(d.oldestUptimeHours!=null)set('stUp',d.oldestUptimeHours+'h');
    set('stOnline',d.botsOnline);set('stServers',d.publicServers);set('stUsers',d.users);
  }).catch(function(){});
  function ago(t){var m=Math.max(0,Math.round((Date.now()-new Date(t).getTime())/60000));if(isNaN(m))return '';if(m<60)return m+' min';var h=Math.round(m/60);return h<24?h+' h':Math.round(h/24)+' j';}
  get('/api/activity').then(function(a){
    if(!Array.isArray(a)||!a.length)return;
    var list=$('actList');list.textContent='';
    a.slice(0,5).forEach(function(x){
      var r=document.createElement('div');r.className='act';
      var i=document.createElement('div');i.className='ai';i.textContent=x.icon||'•';
      var t=document.createElement('div');t.className='at';t.textContent=x.text||'';
      var m=document.createElement('span');m.className='tm';m.textContent=ago(x.at);
      r.appendChild(i);r.appendChild(t);r.appendChild(m);list.appendChild(r);
    });
  }).catch(function(){});
  $('promoBuy').addEventListener('click',function(){var b=$('showPremium');if(b)b.click();});
})();

/* Clé API et Mes serveurs.
   Routes attendues côté serveur (à écrire) :
   GET  /api/key         -> {exists:true|false}
   POST /api/key         -> {key}   (crée la clé, affichée une seule fois ; stocker seulement son hash)
   POST /api/key/renew   -> {key}   (révoque l'ancienne)
   GET  /api/my-servers  -> [{name, host, online}]
   POST /api/my-servers  {name, host} -> serveur ajouté */
(function(){
  var $=function(id){return document.getElementById(id);};
  function say(t){var el=$('toast');if(!el)return;el.textContent=t;el.classList.add('show');setTimeout(function(){el.classList.remove('show');},3000);}
  function api(u,m,b){
    return fetch(u,{method:m||'GET',credentials:'same-origin',headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined})
      .then(function(r){return r.ok?r.json():Promise.reject();});
  }
  /* ---- Clé API ---- */
  var kv='',exists=false,inp=$('apiKey');
  $('keyEx').textContent='curl -H "x-api-key: VOTRE_CLÉ" \\\n  '+location.origin+'/api/bots';
  function ui(){
    inp.value=kv||(exists?'••••••••••••••••':'');
    inp.type=kv?'password':'text';
    $('keyGet').classList.toggle('off',exists||!!kv);
    $('keyRenew').classList.toggle('off',!(exists||kv));
  }
  function created(d){if(!d||!d.key)throw 0;kv=d.key;exists=true;ui();say('Clé créée. Copie-la maintenant, elle ne sera plus affichée.');}
  $('keyGet').addEventListener('click',function(){api('/api/key','POST').then(created).catch(function(){say('Impossible pour le moment.');});});
  $('keyRenew').addEventListener('click',function(){
    if(!confirm('Renouveler la clé révoque immédiatement l\'ancienne. Continuer ?'))return;
    api('/api/key/renew','POST').then(created).catch(function(){say('Impossible pour le moment.');});
  });
  $('keyEye').addEventListener('click',function(){
    if(!kv){say('La clé complète n\'est affichée qu\'à sa création.');return;}
    inp.type=inp.type==='password'?'text':'password';
  });
  $('keyCopy').addEventListener('click',function(){
    if(!kv){say('Rien à copier : la clé n\'est visible qu\'à sa création.');return;}
    if(navigator.clipboard){navigator.clipboard.writeText(kv).then(function(){say('Clé copiée.');},function(){say('Copie impossible.');});}
  });
  api('/api/key').then(function(d){exists=!!(d&&d.exists);ui();}).catch(ui);
  /* ---- Mes serveurs ---- */
  var form=$('srvForm'),box=$('srvMine');
  function load(){
    api('/api/my-servers').then(function(a){
      if(!Array.isArray(a))return;box.textContent='';
      a.forEach(function(s){
        var r=document.createElement('div');r.className='act';
        var i=document.createElement('div');i.className='ai';i.textContent=s.online?'🟢':'⚪';
        var t=document.createElement('div');t.className='at';
        var n=document.createElement('b');n.textContent=s.name||'';
        var h=document.createElement('div');h.className='mut';h.textContent=s.host||'';
        t.appendChild(n);t.appendChild(h);r.appendChild(i);r.appendChild(t);box.appendChild(r);
      });
    }).catch(function(){});
  }
  $('srvAdd').addEventListener('click',function(){form.classList.toggle('off');});
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var n=$('srvName').value.trim(),h=$('srvHost').value.trim();
    if(n.length<2||h.length<4){say('Remplis le nom et l\'adresse.');return;}
    api('/api/my-servers','POST',{name:n,host:h}).then(function(){say('Serveur ajouté.');form.reset();form.classList.add('off');load();})
      .catch(function(){say('Impossible pour le moment.');});
  });
  load();
})();

/* ---- Application installable (PWA) ----
   Enregistre le service worker et affiche le bouton « Installer l'app » quand le navigateur le permet. */
(function(){
  if("serviceWorker" in navigator){
    window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});
  }
  var btn=document.getElementById("installApp"),deferred=null;
  if(!btn)return;
  var standalone=(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches)||window.navigator.standalone;
  if(standalone)return;
  window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();deferred=e;btn.classList.remove("off");});
  btn.addEventListener("click",function(){
    if(!deferred)return;
    deferred.prompt();
    deferred.userChoice.then(function(){deferred=null;btn.classList.add("off");});
  });
  window.addEventListener("appinstalled",function(){btn.classList.add("off");});
})();
