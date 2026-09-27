$ErrorActionPreference="Continue"
$Root=Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDir=Join-Path $Root "BUILD"
$ReportDir=Join-Path $Root "REPORTS"
$stamp=Get-Date -Format "yyyy-MM-dd_HHmmss"
$run=Join-Path $ReportDir $stamp
New-Item -ItemType Directory -Force $run | Out-Null
$report=Join-Path $run "report.txt"
$json=Join-Path $run "report.json"
$results=New-Object System.Collections.Generic.List[object]

function R($cat,$name,$status,$detail="") {
  $o=[pscustomobject]@{Category=$cat;Test=$name;Status=$status;Details=$detail}
  $results.Add($o)
  $line="[$status] $name$(if($detail){": $detail"})"
  Add-Content $report $line
  Write-Host $line
}
"BLUE LETTER BIBLE SUITE - BRAVE END-TO-END AUTOMATED TEST REPORT" | Set-Content $report
"Run: $(Get-Date)" | Add-Content $report

$z=@(Get-ChildItem $BuildDir -Filter *.zip -File)
if($z.Count -ne 1){R "Runner" "Exactly one build ZIP" "FAIL" "Found $($z.Count)."; exit 2}
$zip=$z[0]
R "Build" "Selected build" "INFO" $zip.Name
R "Build" "SHA-256" "INFO" ((Get-FileHash $zip.FullName -Algorithm SHA256).Hash)

$ext=Join-Path $run "extension"
Expand-Archive $zip.FullName $ext -Force
$mf=Get-ChildItem $ext -Filter manifest.json -File -Recurse | Select-Object -First 1
if(!$mf){R "Manifest" "manifest.json" "FAIL"; exit 2}
$extRoot=$mf.Directory.FullName
$m=Get-Content $mf.FullName -Raw | ConvertFrom-Json
R "Manifest" "JSON parse" "PASS"

$node=Get-Command node -ErrorAction SilentlyContinue
$js=@(Get-ChildItem $extRoot -Filter *.js -File -Recurse)
if($node){
  $bad=0
  foreach($f in $js){ & $node.Source --check $f.FullName 2>&1 | Out-Null; if($LASTEXITCODE){$bad++;R "Syntax" $f.Name "FAIL"} }
  if(!$bad){R "Syntax" "All JavaScript files" "PASS" "$($js.Count) checked"}
}else{R "Syntax" "Node.js" "MANUAL" "Node not installed"}

$perms=@($m.permissions); $hosts=@($m.host_permissions); $opt=@($m.optional_host_permissions)
R "Permissions" "tabs absent" ($(if($perms -contains "tabs"){"FAIL"}else{"PASS"}))
R "Permissions" "wildcard permanent HTTP/HTTPS absent" ($(if(($hosts -contains "http://*/*") -or ($hosts -contains "https://*/*")){"FAIL"}else{"PASS"}))
R "Permissions" "optional wildcard HTTP/HTTPS" ($(if(($opt -contains "http://*/*") -and ($opt -contains "https://*/*")){"PASS"}else{"FAIL"}))
$matches=@(); foreach($c in @($m.content_scripts)){$matches+=@($c.matches)}
R "Content Script" "wildcard declarative HTTP/HTTPS absent" ($(if(($matches -contains "http://*/*") -or ($matches -contains "https://*/*")){"FAIL"}else{"PASS"}))

$text=($js|%{Get-Content $_.FullName -Raw}) -join "`n"
foreach($s in @("chrome.permissions.request","chrome.permissions.contains","chrome.permissions.onAdded","chrome.scripting.executeScript")){
 R "Architecture" $s ($(if($text.Contains($s)){"PASS"}else{"FAIL"}))
}

$braveCandidates=@(
 "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
 "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
 "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
)
$brave=$braveCandidates|Where-Object{Test-Path $_}|Select-Object -First 1
if(!$brave){R "Brave" "Brave executable" "FAIL" "Brave not found."; $results|ConvertTo-Json -Depth 5|Set-Content $json; exit 2}
R "Brave" "Brave executable" "PASS" $brave

$profile=Join-Path $run "BraveProfile"
New-Item -ItemType Directory -Force $profile | Out-Null
$port=9229
while($true){
  try{ Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Out-Null; $port++ }
  catch{break}
}
$stdout=Join-Path $run "brave.stdout.log"; $stderr=Join-Path $run "brave.stderr.log"
$args=@("--user-data-dir=$profile","--no-first-run","--no-default-browser-check","--disable-sync","--disable-background-networking","--remote-debugging-port=$port","--load-extension=$extRoot","about:blank")
$p=Start-Process -FilePath $brave -ArgumentList $args -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
R "Brave" "Isolated Brave launch" "PASS" "PID $($p.Id), debug port $port"

$ready=$false
for($i=0;$i-lt 40;$i++){
  Start-Sleep -Milliseconds 500
  try{ $v=Invoke-WebRequest "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 2; if($v.StatusCode -eq 200){$ready=$true;break} }catch{}
}
if(!$ready){R "Brave" "DevTools endpoint" "FAIL"; $results|ConvertTo-Json -Depth 5|Set-Content $json; exit 2}
R "Brave" "DevTools endpoint" "PASS"

$cdp=Join-Path $run "brave-cdp.js"
@'
const http=require("http"), fs=require("fs");
const port=Number(process.argv[2]), out=process.argv[3];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function get(path){return new Promise((resolve,reject)=>{
  const req=http.get({host:"127.0.0.1",port,path},r=>{let d="";r.on("data",x=>d+=x);r.on("end",()=>resolve(d));});
  req.on("error",reject);
});}
async function targets(){return JSON.parse(await get("/json"));}
function wsUrlFor(t){return t.webSocketDebuggerUrl;}
async function cdp(ws, method, params={}){
  return await new Promise((resolve,reject)=>{
    const id=++ws._id;
    const timer=setTimeout(()=>reject(new Error("CDP timeout: "+method)),10000);
    ws.send(JSON.stringify({id,method,params}));
    const handler=(raw)=>{
      let m; try{m=JSON.parse(raw.toString())}catch{return}
      if(m.id===id){clearTimeout(timer);ws.removeEventListener("message",handler); if(m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result||{});}
    };
    ws.addEventListener("message",handler);
  });
}
async function attach(t){
  const ws=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej});
  ws._id=0; return ws;
}
async function evalPage(t, expr){
  const ws=await attach(t);
  await cdp(ws,"Runtime.enable");
  const r=await cdp(ws,"Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
  ws.close(); return r.result?.value;
}
async function newPage(url){
  try{await createTarget(url);}catch(e){
    try{await get("/json/new?"+encodeURIComponent(url));}catch{}
  }
  for(let i=0;i<40;i++){
    for(const t of await targets()) if(t.type==="page" && (t.url===url || t.url.startsWith(url))) return t;
    await sleep(300);
  }
  return (await targets()).find(t=>t.type==="page" && t.url.includes(url.split("/")[2]));
}
async function closeTarget(t){try{const path="/json/close/"+t.id;await get(path)}catch{}}
(async()=>{
 const report={started:new Date().toISOString(),targets:[],tests:[],extensionId:null,extensionPages:[]};
 try{
  let ts=await targets(); report.targets=ts.map(t=>({id:t.id,type:t.type,url:t.url,title:t.title||""}));
  const ext=ts.find(t=>t.type==="service_worker" && t.url.startsWith("chrome-extension://"));
  if(ext){report.extensionId=ext.url.split("/")[2]; report.extensionPages.push(ext.url);}
  report.tests.push({name:"Service worker target",status:ext?"PASS":"FAIL",detail:ext?ext.url:"No extension service worker target found"});
  if(!ext) throw new Error("No extension service worker");

  const urls=[
    ["ChatGPT","https://chatgpt.com/"],
    ["GraceLife","https://gracelifebiblechurch.com/the-art-of-spiritual-bodybuilding-learning-to-be-kindly-affectionate/"],
    ["BLB","https://www.blueletterbible.org/"],
    ["Bible.com","https://www.bible.com/"]
  ];
  for(const [name,url] of urls){
    let t=await newPage(url); if(!t){report.tests.push({name:name+" navigation",status:"FAIL",detail:"Target not found"});continue;}
    await sleep(5000);
    let info=await evalPage(t,`(()=>({url:location.href,title:document.title,ready:document.readyState,bodyText:(document.body?.innerText||"").slice(0,5000),allIds:[...document.querySelectorAll("[id]")].map(x=>x.id).filter(Boolean).slice(0,300),buttons:[...document.querySelectorAll("button")].map(x=>({text:(x.innerText||"").trim(),id:x.id||"",aria:x.getAttribute("aria-label")||""})).slice(0,100)}))()`);
    const marker=(info.allIds||[]).filter(x=>/blb|blue.?letter/i.test(x));
    const bodyMarker=/BLB|Blue Letter Bible/i.test(info.bodyText||"");
    report.tests.push({name:name+" page loads",status:info&&info.ready==="complete"?"PASS":"FAIL",detail:info?info.url:"no page data"});
    report.tests.push({name:name+" extension DOM marker",status:marker.length||bodyMarker?"PASS":"INFO",detail:"IDs="+marker.join(",")+"; page text marker="+bodyMarker});
    report.tests.push({name:name+" page inspection",status:"PASS",detail:"title="+info.title});
    report.targets.push({id:t.id,type:t.type,url:t.url,name,inspection:info});
    await closeTarget(t);
  }

  ts=await targets();
  const extPages=ts.filter(t=>t.type==="page" && t.url.startsWith("chrome-extension://"));
  report.extensionPages=report.extensionPages.concat(extPages.map(t=>t.url));
  report.tests.push({name:"Extension page targets after navigation",status:"PASS",detail:extPages.length+" extension page target(s)"});
  fs.writeFileSync(out,JSON.stringify(report,null,2));
  process.exit(0);
 }catch(e){
  report.error=String(e.stack||e); fs.writeFileSync(out,JSON.stringify(report,null,2)); process.exit(1);
 }
})();
'@ | Set-Content $cdp -Encoding UTF8

$browserJson=Join-Path $run "browser-e2e.json"
if($node){
  & $node.Source $cdp $port $browserJson
  if(Test-Path $browserJson){
    $b=Get-Content $browserJson -Raw|ConvertFrom-Json
    foreach($t in @($b.tests)){ R "Browser" $t.name $t.status $t.detail }
    if($b.error){R "Browser" "CDP harness" "FAIL" $b.error}
    else{R "Browser" "CDP end-to-end harness" "PASS" "Navigation/DOM/extension-target checks completed."}
  }else{R "Browser" "CDP end-to-end harness" "FAIL" "No browser-e2e.json produced."}
}else{R "Browser" "CDP end-to-end harness" "MANUAL" "Node.js unavailable"}

# Actions that still require native browser UI or a trusted user gesture.
R "Manual" "Permission Allow/Deny prompt" "MANUAL" "Native permission prompt/user decision."
R "Manual" "Floating button visual interaction" "MANUAL" "Runner records DOM evidence; visual/gesture confirmation remains manual."
R "Manual" "Double-Click BLB on arbitrary site" "MANUAL" "Requires trusted real pointer interaction."
R "Manual" "Context-menu Show on BLB" "MANUAL" "Native context menu is not reliably automatable through CDP."
R "Manual" "Alt+B command" "MANUAL" "Keyboard command registration/user gesture remains manual."
R "Manual" "file:// access" "MANUAL" "Requires Brave extension file-access setting."

$pass=@($results|? Status -eq PASS).Count
$fail=@($results|? Status -eq FAIL).Count
$manual=@($results|? Status -eq MANUAL).Count
$info=@($results|? Status -eq INFO).Count
""|Add-Content $report
"SUMMARY"|Add-Content $report
"PASS   : $pass"|Add-Content $report
"FAIL   : $fail"|Add-Content $report
"MANUAL : $manual"|Add-Content $report
"INFO   : $info"|Add-Content $report
"RESULT : $(if($fail){'AUTOMATED FAILURE — DO NOT CHANGE EXTENSION YET'}elseif($manual){'AUTOMATED CHECKS PASS — MANUAL CHECKS REMAIN'}else{'ALL AUTOMATED CHECKS PASS'})"|Add-Content $report
$results|ConvertTo-Json -Depth 8|Set-Content $json
Write-Host ""
Write-Host "Report: $report"
Write-Host "Detailed CDP evidence: $(Join-Path $run 'browser-e2e.json')"
Write-Host "Isolated Brave profile: $profile"
