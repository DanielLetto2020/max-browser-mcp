#!/usr/bin/python3
import base64,os,re,sys,json,socket,struct,threading,time,uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
BASE=Path(__file__).resolve().parent
SOCKET=str(BASE/'run'/'browser.sock')
VERSION='3.0.0'
CLIENT_ID=uuid.uuid4().hex[:12]

SENSITIVE_UPLOAD_EXACT_PREFIXES=('/etc/shadow','/etc/passwd','/etc/gshadow','/proc/','/sys/')
SENSITIVE_UPLOAD_SUBPATHS=(
 '/.ssh/','/.gnupg/','/.aws/','/.kube/','/.docker/config.json',
 '/.git-credentials','/.netrc','/.npmrc','/.pypirc','/.mcp-auth/',
 '/.config/google-chrome/','/.config/chromium/','/.mozilla/'
)

CORE_TOOLS={
 'browser_status','browser_config','tabs_list','tabs_create','tabs_close',
 'navigate','reload','wait_page','page_snapshot','get_page_text','page_markdown',
 'find_elements','extract_structured','click','fill','fill_form','select_option',
 'set_checked','press_key','scroll','scroll_to_text','screenshot','batch','handle_dialog'
}
QA_TOOLS=CORE_TOOLS|{
 'audit_layout','audit_responsive','accessibility_audit','performance_metrics',
 'visual_diff','diagnostics_start','diagnostics_get','diagnostics_stop','wait_network',
 'network_har_export','route_mock','route_clear','emulate','frames_list','get_styles',
 'highlight_element','wait_for','wait_change','wait_until_js','recorder_control'
}

def get_profile(argv=None):
 args_list=sys.argv[1:] if argv is None else argv
 if '--profile' in args_list:
  idx=args_list.index('--profile')
  if idx+1<len(args_list):return args_list[idx+1].strip().lower()
 for a in args_list:
  if a.startswith('--profile='):return a.split('=',1)[1].strip().lower()
 return os.environ.get('MAX_BROWSER_PROFILE','full').strip().lower()

def get_profile_tools(profile='full'):
 if profile=='core':return [t for t in TOOLS if t[0] in CORE_TOOLS]
 if profile=='qa':return [t for t in TOOLS if t[0] in QA_TOOLS]
 return TOOLS

def read_exact(stream,n):
 data=b''
 while len(data)<n:
  chunk=stream.read(n-len(data))
  if not chunk:return None
  data+=chunk
 return data

def native():
 run=BASE/'run';run.mkdir(mode=0o700,exist_ok=True)
 if Path(SOCKET).exists():
  alive=False
  for _ in range(15):
   if not Path(SOCKET).exists():
    alive=False
    break
   probe=socket.socket(socket.AF_UNIX)
   try:
    probe.settimeout(0.2)
    probe.connect(SOCKET)
    alive=True
   except OSError:
    alive=False
    break
   finally:
    probe.close()
   time.sleep(0.1)
  if alive:return
  try:
   if Path(SOCKET).exists():Path(SOCKET).unlink()
  except OSError:
   pass
 server=socket.socket(socket.AF_UNIX)
 server.bind(SOCKET)
 os.chmod(SOCKET,0o600)
 server.listen()
 bound_ino=os.stat(SOCKET).st_ino
 def cleanup_socket():
  try:
   if Path(SOCKET).exists() and os.stat(SOCKET).st_ino==bound_ino:
    Path(SOCKET).unlink()
  except OSError:
   pass
 pending={};chunk_buffers={};lock=threading.Lock()
 def deliver(message):
  mid=message.get('id')
  item=pending.get(mid)
  if item:
   item[1].append(message)
   item[0].set()
 def receive():
  try:
   while True:
    head=read_exact(sys.stdin.buffer,4)
    if not head:break
    size=struct.unpack('<I',head)[0]
    if size>32*1024*1024:break
    raw=read_exact(sys.stdin.buffer,size)
    if raw is None:break
    message=json.loads(raw)
    if '__chunk' in message:
     mid=message.get('id')
     idx=message.get('__chunk')
     total=message.get('__total')
     if not isinstance(idx,int) or not isinstance(total,int) or total<=0 or idx<0 or idx>=total:
      continue
     buf=chunk_buffers.setdefault(mid,[None]*total)
     if len(buf)!=total:
      buf=[None]*total
      chunk_buffers[mid]=buf
     buf[idx]=message.get('data','')
     if all(part is not None for part in buf):
      chunk_buffers.pop(mid,None)
      try:
       full=json.loads(''.join(buf))
      except Exception as e:
       full={'id':mid,'error':f'Invalid chunked response: {e}'}
      deliver(full)
    else:
     deliver(message)
  finally:
   cleanup_socket()
   os._exit(0)
 threading.Thread(target=receive,daemon=True).start()
 def client(conn):
  key=None
  try:
   raw=conn.makefile('rb').readline(8*1024*1024)
   if not raw:return
   m=json.loads(raw)
   key=uuid.uuid4().hex
   timeout_sec=float(m.pop('timeoutSec',45))
   m['id']=key
   event=threading.Event();answers=[];pending[key]=(event,answers)
   encoded=json.dumps(m).encode()
   with lock:
    sys.stdout.buffer.write(struct.pack('<I',len(encoded))+encoded)
    sys.stdout.buffer.flush()
   if not event.wait(timeout_sec):raise TimeoutError('Chrome did not respond')
   conn.sendall(json.dumps(answers[0]).encode()+b'\n')
  except Exception as e:
   try:conn.sendall(json.dumps({'error':str(e)}).encode()+b'\n')
   except OSError:pass
  finally:
   if key:
    pending.pop(key,None)
    chunk_buffers.pop(key,None)
   conn.close()
 try:
  while True:
   conn,_=server.accept()
   threading.Thread(target=client,args=(conn,),daemon=True).start()
 finally:
  cleanup_socket()

def P(typ,desc,**kw):return {'type':typ,'description':desc,**kw}
def schema(props,required):
 resolved={}
 for k,v in props.items():
  resolved[k]={'type':v} if isinstance(v,str) else v
 return {'type':'object','properties':resolved,'required':required,'additionalProperties':False}

COORD={'type':'array','items':{'type':'number'},'minItems':2,'maxItems':2,'description':'Viewport or last-screenshot [x, y] coordinate in pixels'}
REGION={'type':'array','items':{'type':'number'},'minItems':4,'maxItems':4,'description':'Capture region [x0, y0, x1, y1] in viewport or last-screenshot pixels'}
MODIFIERS={'anyOf':[{'type':'integer','minimum':0,'maximum':15},{'type':'string'}],'description':'Modifier keys as string ("ctrl+shift") or bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8)'}
TIMEOUT=P('integer','Maximum wait time in milliseconds (0-30000)',minimum=0,maximum=30000)

TARGET={
 'selector':P('string','CSS selector (supports open Shadow DOM)'),
 'ref':P('string','Element reference ID from page_snapshot or find_elements'),
 'mark':P('integer','Set-of-Mark badge number from the last screenshot(annotate=true)',minimum=1,maximum=120),
 'text':P('string','Visible text content to match'),
 'role':P('string','ARIA role or implicit HTML role (e.g. button, textbox, link)'),
 'name':P('string','Accessible name (label, aria-label, placeholder, alt, or button text)'),
 'exact':P('boolean','Whether text/name matching must be exact (default true; false matches substring)'),
 'nth':P('integer','Zero-based match index when multiple elements match',minimum=0),
 'frameId':P('integer','Target frame ID from frames_list (default 0 = main frame)',minimum=0),
}
EXPECT=schema({
 **TARGET,
 'url':P('string','Expected exact page URL after action'),
 'urlIncludes':P('string','Expected substring in page URL after action'),
 'textIncludes':P('string','Expected substring in visible page text after action'),
 'value':P('string','Expected input/select value for the target element'),
 'checked':P('boolean','Expected checked state for checkbox/radio target'),
 'state':P('string','Expected element visibility/DOM state',enum=['attached','visible','hidden','detached']),
 'timeoutMs':TIMEOUT,
},[])
EXPECT['description']='Post-action outcome assertions to verify before returning'

TAB_ID=P('integer','Target Chrome tab ID (defaults to last controlled or active tab)')
TAB_SEL=P('string','Tab selection hint when tabId is omitted ("last" or "active")',enum=['active','last'])
FAST_OPT=P('boolean','Skip blocking cursor animation delay for faster execution')
COMPACT_OPT=P('boolean','Return concise response fields to save tokens')
VERBOSE_OPT=P('boolean','Include full element/action details even when global compactResponses is enabled')
AFTER_SNAP=P('string','Attach a fresh page_snapshot ("diff", "interactive", or "tree") right after the action completes',enum=['diff','interactive','tree'])
ON_DIALOG=P('string','Proactively handle JS alert/confirm/prompt opened by this action',enum=['accept','dismiss'])
DIALOG_PROMPT=P('string','Prompt input text when onDialog="accept"')

BATCH_COND=schema({
 'selector':P('string','CSS selector to test'),
 'textIncludes':P('string','Required visible page text substring'),
 'urlIncludes':P('string','Required substring in current tab URL'),
 'visible':P('boolean','Require matched selector to be visible'),
 'notExists':P('boolean','Invert selector check (match when 0 elements match)'),
},[])

def _step_item_schema(allow_parallel=True):
 props={
  'name':P('string','Tool name to call'),
  'arguments':P('object','Arguments object for the tool'),
  'retries':P('integer','Optional retries on step failure (0-3, default 0)',minimum=0,maximum=3),
  'retryDelayMs':P('integer','Delay in ms between retries (50-5000, default 250)',minimum=50,maximum=5000),
  'optional':P('boolean','Ignore step failure and continue batch (default false)'),
  'when':BATCH_COND,
  'repeatUntil':schema({
   'selector':P('string','CSS selector whose presence/absence stops repetition'),
   'textIncludes':P('string','Page text substring whose presence stops repetition'),
   'urlIncludes':P('string','Tab URL substring whose presence stops repetition'),
   'visible':P('boolean','Require selector to be visible'),
   'notExists':P('boolean','Stop when selector disappears'),
   'maxIterations':P('integer','Maximum repeat iterations (1-15, default 10)',minimum=1,maximum=15),
  },[]),
 }
 if allow_parallel:
  props['parallel']=P('array','Run nested sub-actions concurrently via Promise.all',minItems=1,maxItems=10,items=_step_item_schema(False))
 return {'type':'object','properties':props,'required':[],'additionalProperties':False}

TOOLS=[
 ('tabs_list','List open Chrome tabs with IDs, URLs, titles, indexes, pinned/muted/group state',{},[]),
 ('tabs_create','Create a Chrome tab',{'url':P('string','Initial URL to open (defaults to about:blank)')},[]),
 ('navigate','Navigate Chrome tab (defaults to active/last controlled tab); optional dismissCookies & afterSnapshot',{'tabId':TAB_ID,'tab':TAB_SEL,'url':P('string','Destination URL'),'dismissCookies':P('boolean','Attempt to auto-accept visible cookie consent banner after navigation'),'afterSnapshot':AFTER_SNAP,'onDialog':ON_DIALOG,'dialogPromptText':DIALOG_PROMPT},['url']),
 ('get_page_text','Read page title, URL, and visible text (supports mainOnly, maxChars, and grep/around search filtering)',{'tabId':TAB_ID,'tab':TAB_SEL,'mainOnly':P('boolean','Extract primary main/article content instead of full body (default true)'),'maxChars':P('integer','Maximum characters to return (500-200000)',minimum=500,maximum=200000),'grep':P('string','Filter lines matching substring or /regex/flags with surrounding context'),'around':P('integer','Context lines around each grep match (0-20, default 2)',minimum=0,maximum=20)},[]),
 ('read_dom','Read outerHTML of a CSS selector or element target (truncated by maxChars)',{'tabId':TAB_ID,'tab':TAB_SEL,'selector':P('string','CSS selector (defaults to body)'),'maxChars':P('integer','Maximum HTML characters to return (500-200000, default 50000)',minimum=500,maximum=200000)},[]),
 ('javascript','Execute a JavaScript expression in the page MAIN world; top-level await and CSP fallback supported',{'tabId':TAB_ID,'tab':TAB_SEL,'code':P('string','JavaScript expression or statements to execute')},['code']),
 ('screenshot','Capture Chrome page, element, fullPage, tiles, or viewport region [x0,y0,x1,y1]; supports preset (fast/normal/hd), dedupe, grid overlay, Set-of-Mark annotate=true, and savePath',{'tabId':TAB_ID,'tab':TAB_SEL,'region':REGION,'preset':P('string','Token/quality preset: fast (1024px JPEG), normal, or hd',enum=['fast','normal','hd']),'dedupe':P('boolean','Skip returning image bytes if identical hash to previous screenshot on tab (default false)'),'grid':P('boolean','Overlay pixel coordinate grid on screenshot for canvas/charts/maps'),'gridStep':P('integer','Coordinate grid spacing in px (25-400, default 100)',minimum=25,maximum=400),'annotate':P('boolean','Overlay numbered Set-of-Mark badges on visible interactive elements'),'annotateLimit':P('integer','Maximum number of Set-of-Mark badges (1-120, default 80)',minimum=1,maximum=120),'savePath':P('string','Write image/tiles directly to this local file path'),'returnImage':P('boolean','Include base64 image in MCP output when savePath is set (default false)'),'tiles':P('boolean','Capture long page as multiple readable viewport tiles instead of downscaling'),'maxTiles':P('integer','Maximum viewport tiles to capture (1-12, default 6)',minimum=1,maximum=12)},[]),
 ('click','Click an element target (selector/ref/mark/role/name/text) or viewport/screenshot coordinate [x,y]; checks occlusion, supports afterSnapshot, compact, onDialog',{'tabId':TAB_ID,'tab':TAB_SEL,'coordinate':COORD,'button':P('string','Mouse button to click (default left)',enum=['left','right','middle']),'clickCount':P('integer','Number of clicks (1=single, 2=double, 3=triple)',minimum=1,maximum=3),'modifiers':MODIFIERS,'actionTimeoutMs':P('integer','Retry window in ms until target becomes visible and unobstructed (0-10000, default 2000)',minimum=0,maximum=10000),'checkOcclusion':P('boolean','Verify target is not covered by another element before clicking (default true)'),'onDialog':ON_DIALOG,'dialogPromptText':DIALOG_PROMPT,'afterSnapshot':AFTER_SNAP,'compact':COMPACT_OPT,'verbose':VERBOSE_OPT,'fast':FAST_OPT},[]),
 ('hover','Move mouse cursor over an element target or coordinate [x,y]',{'tabId':TAB_ID,'tab':TAB_SEL,'coordinate':COORD,'compact':COMPACT_OPT,'verbose':VERBOSE_OPT,'fast':FAST_OPT},[]),
 ('drag','Drag mouse from startCoordinate or start element to coordinate or target element',{'tabId':TAB_ID,'tab':TAB_SEL,'startCoordinate':COORD,'coordinate':COORD,'startSelector':P('string','CSS selector for drag start element'),'startRef':P('string','Element ref for drag start element'),'targetSelector':P('string','CSS selector for drag drop target element'),'targetRef':P('string','Element ref for drag drop target element'),'frameId':P('integer','Frame ID for element drag targets (default 0)',minimum=0),'modifiers':MODIFIERS,'fast':FAST_OPT},[]),
 ('fill','Set a form field and dispatch composed input/change events; supports afterSnapshot & compact',{'tabId':TAB_ID,'tab':TAB_SEL,'selector':P('string','CSS selector of the input/textarea/contenteditable'),'value':P('string','Value to set in the field'),'actionTimeoutMs':P('integer','Retry window in ms until element is actionable (0-10000, default 2000)',minimum=0,maximum=10000),'strict':P('boolean','Fail if masked/formatted input modifies value after input events (default false; still fails if value unchanged)'),'afterSnapshot':AFTER_SNAP,'compact':COMPACT_OPT,'verbose':VERBOSE_OPT,'fast':FAST_OPT},['value']),
 ('tabs_move','Move a tab to a zero-based index or relatively by offset; use instead of browser keyboard shortcuts',{'tabId':TAB_ID,'index':P('integer','Zero-based destination tab index (-1 for end)'),'offset':P('integer','Relative index offset (e.g. -1 moves left, +1 moves right)'),'windowId':P('integer','Destination Chrome window ID')},[]),
 ('tabs_reorder','Reorder specified tabs in their existing slots; preserve unrelated tabs; all IDs must belong to one window',{'tabIds':P('array','Tab IDs in desired relative order',items={'type':'integer'},minItems=1,uniqueItems=True)},['tabIds']),
 ('tabs_activate','Select a tab and focus its Chrome window',{'tabId':TAB_ID},[]),
 ('tabs_update','Pin/unpin or mute/unmute a tab',{'tabId':TAB_ID,'pinned':P('boolean','Pin or unpin tab'),'muted':P('boolean','Mute or unmute tab audio')},[]),
 ('tabs_close','Close a specified tab (only when authorized by the user)',{'tabId':P('integer','Required tab ID to close')},['tabId']),
 ('tabs_duplicate','Duplicate a tab',{'tabId':TAB_ID},[]),
 ('reload','Reload a page, optionally bypassing cache',{'tabId':TAB_ID,'tab':TAB_SEL,'bypassCache':P('boolean','Bypass browser cache when reloading'),'afterSnapshot':AFTER_SNAP},[]),
 ('history','Navigate back or forward',{'tabId':TAB_ID,'tab':TAB_SEL,'direction':P('string','History navigation direction',enum=['back','forward']),'afterSnapshot':AFTER_SNAP},['direction']),
 ('scroll','Scroll the page, a matched element, or wheel-scroll at coordinate [x,y] by direction/amount',{'tabId':TAB_ID,'tab':TAB_SEL,'selector':P('string','CSS selector of scrollable container'),'x':P('integer','Horizontal scroll delta in pixels'),'y':P('integer','Vertical scroll delta in pixels'),'intoView':P('boolean','Scroll matched element into the center of the viewport'),'coordinate':COORD,'direction':P('string','Wheel scroll direction',enum=['up','down','left','right']),'amount':P('integer','Number of wheel ticks (1-20, 100px each, default 3)',minimum=1,maximum=20),'compact':COMPACT_OPT,'verbose':VERBOSE_OPT,'fast':FAST_OPT},[]),
 ('select_option','Set a native select option by value or visible text and dispatch input/change',{'tabId':TAB_ID,'tab':TAB_SEL,'selector':P('string','CSS selector of <select> element'),'value':P('string','Option value or visible text to select'),'afterSnapshot':AFTER_SNAP,'compact':COMPACT_OPT,'verbose':VERBOSE_OPT,'fast':FAST_OPT},['value']),
 ('set_checked','Set checkbox/radio state using its click behavior',{'tabId':TAB_ID,'tab':TAB_SEL,'selector':P('string','CSS selector of checkbox or radio input'),'checked':P('boolean','Desired checked state'),'afterSnapshot':AFTER_SNAP,'compact':COMPACT_OPT,'verbose':VERBOSE_OPT,'fast':FAST_OPT},['checked']),
 ('press_key','Send trusted key or key sequence/combo (e.g. "Enter", "ctrl+a", "Shift+A", "Backspace Backspace"); supports repeat and string or bitmask modifiers',{'tabId':TAB_ID,'tab':TAB_SEL,'key':P('string','Key name, combination ("ctrl+a"), or space-separated sequence'),'code':P('string','Explicit DOM KeyboardEvent.code override'),'modifiers':MODIFIERS,'repeat':P('integer','Number of times to repeat the sequence (1-50, default 1)',minimum=1,maximum=50),'selector':P('string','Optional target selector to focus first'),'onDialog':ON_DIALOG,'dialogPromptText':DIALOG_PROMPT,'afterSnapshot':AFTER_SNAP,'compact':COMPACT_OPT,'verbose':VERBOSE_OPT,'fast':FAST_OPT},['key']),
 ('insert_text','Type text into focused page input using Chrome debugger; optional selector/ref/mark/role/name/targetText to focus first',{'tabId':TAB_ID,'tab':TAB_SEL,'text':P('string','Text string to insert into the focused input'),'targetText':P('string','Visible text of element to focus before typing (use instead of target text)'),'selector':P('string','Optional target CSS selector to focus first'),'compact':COMPACT_OPT,'verbose':VERBOSE_OPT,'fast':FAST_OPT},['text']),
 ('wait_for','Wait for element target (attached/visible/hidden/detached); optional stableMs waits for layout stability',{'tabId':TAB_ID,'tab':TAB_SEL,'selector':P('string','CSS selector of element to wait for'),'visible':P('boolean','Shorthand for state="visible" when true'),'stableMs':P('integer','Require bounding box stability for this many ms (0-5000)',minimum=0,maximum=5000),'timeoutMs':TIMEOUT},[]),
 ('query_elements','Read multiple matches with text, attributes and bounding boxes; limit defaults to 100',{'tabId':TAB_ID,'tab':TAB_SEL,'selector':P('string','CSS selector to match'),'limit':P('integer','Maximum number of matched elements to return (1-1000, default 100)',minimum=1,maximum=1000)},[]),
]

page_tools={'read_dom','click','hover','fill','scroll','select_option','set_checked','press_key','insert_text','wait_for','query_elements'}
def _build_page_props(n,p):
 if n=='insert_text':
  target_no_text={k:v for k,v in TARGET.items() if k!='text'}
  return {**p,**target_no_text,'expect':EXPECT}
 return {**p,**TARGET,**({'expect':EXPECT} if n in {'click','fill','select_option','set_checked','press_key'} else {})}

TOOLS=[
 (n,d,_build_page_props(n,p),[k for k in r if k!='selector'])
 if n in page_tools else (n,d,p,r) for n,d,p,r in TOOLS
]
TOOLS=[(n,d,{**p,'frameId':P('integer','Target frame ID from frames_list (default 0 = main frame)',minimum=0)},r) if n in {'get_page_text','javascript'} else (n,d,p,r) for n,d,p,r in TOOLS]
TOOLS=[(n,d,{**p,'state':P('string','Target state to wait for (default attached, or visible if visible=true)',enum=['attached','visible','hidden','detached'])},r) if n=='wait_for' else (n,d,p,r) for n,d,p,r in TOOLS]
TOOLS=[(n,d,{**p,'trusted':P('boolean','Use CDP trusted mouse input (default true); false uses DOM el.click()')},r) if n=='click' else (n,d,p,r) for n,d,p,r in TOOLS]
TOOLS=[(n,d,{**p,'waitUntil':P('string','Navigation lifecycle state to wait for after triggering navigation',enum=['load','domcontentloaded','networkIdle']),'timeoutMs':TIMEOUT},r)
       if n in {'navigate','reload','history'} else (n,d,p,r) for n,d,p,r in TOOLS]
TOOLS=[(n,d,{**p,**TARGET,
             'fullPage':P('boolean','Capture entire scrollable document height (capped at 16000px)'),
             'format':P('string','Image format (default png, or jpeg when preset="fast")',enum=['png','jpeg']),
             'quality':P('integer','JPEG quality 1-100 (default 80 for jpeg, 75 for auto-compression)',minimum=1,maximum=100),
             'scale':P('number','Capture scale factor (0 < scale <= 1)',exclusiveMinimum=0,maximum=1)},r)
       if n=='screenshot' else (n,d,p,r) for n,d,p,r in TOOLS]

IDS=P('array','Non-empty list of unique Chrome tab IDs',items={'type':'integer'},minItems=1,uniqueItems=True)
COLORS=P('string','Chrome tab group color',enum=['grey','blue','red','yellow','green','pink','purple','cyan','orange'])
FAIL_REASONS=P('string','Fail matching requests with CDP network error instead of fulfilling',enum=['Failed','Aborted','TimedOut','AccessDenied','ConnectionClosed','ConnectionRefused','ConnectionReset','ConnectionAborted','ConnectionFailed','NameNotResolved','InternetDisconnected'])

TOOLS += [
 ('browser_status','Connection, extension version, permissions, runtimeConfig, open dialogs and controlled tabs',{},[]),
 ('control_indicator','Enable/disable the softly pulsing Max Browser border on a controlled page',{'tabId':TAB_ID,'enabled':P('boolean','Whether to show the Max control border/cursor on this tab')},['enabled']),
 ('frames_list','List accessible frames with frameId and URL; pass frameId to page tools',{'tabId':TAB_ID,'tab':TAB_SEL},[]),
 ('page_snapshot','Compact accessibility tree (short refs, compactLists=true, viewportOnly, skipLandmarks, diff=true with parent context) or JSON',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'selector':P('string','Root CSS selector for subtree snapshot'),'ref':P('string','Root element ref for subtree snapshot'),'format':P('string','Output format (default tree)',enum=['tree','json']),'filter':P('string','Element filter: all or interactive only (default all)',enum=['all','interactive']),'depth':P('integer','Maximum tree depth (1-50, default 15)',minimum=1,maximum=50),'maxChars':P('integer','Maximum output characters (500-200000, default 50000)',minimum=500,maximum=200000),'diff':P('boolean','Return added/removed lines with parent context relative to previous snapshot'),'includeHidden':P('boolean','Include hidden and aria-hidden elements (default false)'),'compactLists':P('boolean','Fold long repeating lists/tables (>9 similar items) in tree output to save tokens (default true)'),'viewportOnly':P('boolean','Only include elements within or near the visible viewport to cut tokens on long pages (default false)'),'skipLandmarks':P('array','Skip specified tags or ARIA roles as 1-line stubs (e.g. ["nav", "footer", "aside"])',items={'type':'string'}),'limit':P('integer','Maximum elements to include (1-5000)',minimum=1,maximum=5000)},[]),
 ('find_elements','Find elements by natural language query (ranked with container context) and/or CSS/text/role/name/ref; open Shadow DOM supported',{'tabId':TAB_ID,'tab':TAB_SEL,'query':P('string','Natural language query (e.g. "Save button", "кнопка войти")'),**TARGET,'visible':P('boolean','Restrict results to visible elements only'),'limit':P('integer','Maximum results to return (1-1000, default 20 for query, 100 otherwise)',minimum=1,maximum=1000)},[]),
 ('wait_change','Wait for an element attribute, textContent or value to change or equal a string (resilient to SPA re-renders)',{'tabId':TAB_ID,'tab':TAB_SEL,**TARGET,'attribute':P('string','Attribute name, "textContent" (default), or "value"'),'from':P('string','Baseline value to wait to change away from'),'equals':P('string','Target string value to wait for'),'timeoutMs':TIMEOUT},[]),
 ('wait_page','Wait for page load/DOMContentLoaded or network idle (start diagnostics for networkIdle)',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'state':P('string','Page readiness state (default load)',enum=['load','domcontentloaded','networkIdle']),'urlIncludes':P('string','Required substring in tab URL before resolving'),'idleMs':P('integer','Required quiet period in ms for networkIdle (100-5000, default 500)',minimum=100,maximum=5000),'timeoutMs':TIMEOUT},[]),
 ('groups_list','List Chrome tab groups',{'windowId':P('integer','Optional Chrome window ID filter')},[]),
 ('tabs_group','Create/add to a tab group and set title, color and collapsed state',{'tabIds':IDS,'groupId':P('integer','Existing tab group ID to add tabs into'),'title':P('string','Group title'),'color':COLORS,'collapsed':P('boolean','Whether the tab group is collapsed')},['tabIds']),
 ('group_update','Rename, recolor or collapse/expand a group',{'groupId':P('integer','Target Chrome tab group ID'),'title':P('string','New group title'),'color':COLORS,'collapsed':P('boolean','Whether the group is collapsed')},['groupId']),
 ('tabs_ungroup','Remove specified tabs from their groups',{'tabIds':IDS},['tabIds']),
 ('diagnostics_start','Start bounded network/console/WebSocket/SSE monitoring for one tab; optional captureBodies=true records redacted XHR/Fetch payloads',{'tabId':TAB_ID,'maxEntries':P('integer','Ring buffer capacity per stream (10-1000, default 300)',minimum=10,maximum=1000),'captureBodies':P('boolean','Capture and redact request postData and response text bodies (default false)'),'maxBodyChars':P('integer','Maximum characters per captured body (256-65536, default 8192)',minimum=256,maximum=65536)},[]),
 ('diagnostics_get','Read recent network/console/WebSocket/SSE events (auto-starts monitoring); supports summaryOnly, onlyErrors, pattern regex, urlPattern glob, captureBodies',{'tabId':TAB_ID,'autoStart':P('boolean','Auto-start diagnostics session if inactive (default true)'),'summaryOnly':P('boolean','Return grouped error/status counts instead of raw event arrays to save tokens'),'captureBodies':P('boolean','Enable body capture for subsequent requests'),'maxBodyChars':P('integer','Maximum body chars when auto-starting (256-65536, default 8192)',minimum=256,maximum=65536),'onlyErrors':P('boolean','Filter console to error/exception/assert AND network to failed or HTTP status >= 400'),'pattern':P('string','Regex or substring filter for console and WebSocket/SSE messages'),'urlPattern':P('string','Glob (* wildcards) or substring filter for network/WebSocket URLs'),'clear':P('boolean','Clear buffered network/console/WebSocket entries after reading'),'limit':P('integer','Maximum recent entries per stream (1-300, default 100)',minimum=1,maximum=300)},[]),
 ('diagnostics_stop','Stop debugger monitoring while retaining recorded events',{'tabId':TAB_ID},[]),
 ('upload_files','Select existing absolute local paths in a file input; sensitive system/credential paths blocked; does not submit form',{'tabId':TAB_ID,**TARGET,'files':P('array','Existing absolute local file paths to attach (1-100)',items={'type':'string'},minItems=1,maxItems=100),'expect':EXPECT},['files']),
 ('download_start','Download a user-authorized URL; filename is relative to Downloads; existing files are not overwritten',{'url':P('string','URL to download'),'filename':P('string','Relative destination path inside Chrome Downloads folder'),'saveAs':P('boolean','Show Save As prompt (default false)')},['url']),
 ('downloads_list','List recent downloads and progress',{'limit':P('integer','Maximum downloads to return (1-100, default 20)',minimum=1,maximum=100)},[]),
 ('download_wait','Wait up to 30 seconds for a download, returning progress if still running',{'downloadId':P('integer','Download ID from download_start or downloads_list'),'timeoutMs':TIMEOUT},['downloadId']),
 ('handle_dialog','Accept or dismiss an open JavaScript alert/confirm/prompt dialog on a tab',{'tabId':TAB_ID,'accept':P('boolean','Accept (true, default) or dismiss (false) the dialog'),'promptText':P('string','Input text for prompt() dialogs')},[]),
 ('resize_window','Resize Chrome window containing tabId (or specified windowId) to width x height',{'tabId':TAB_ID,'windowId':P('integer','Explicit Chrome window ID'),'width':P('integer','Target window width in pixels (200-7680)',minimum=200,maximum=7680),'height':P('integer','Target window height in pixels (200-4320)',minimum=200,maximum=4320)},['width','height']),
 ('emulate','Emulate mobile viewport/touch, prefers-color-scheme, User-Agent, locale, timezone, offline/throttled network, or geolocation via CDP; merges across calls; pass reset=true to clear',{'tabId':TAB_ID,'width':P('integer','Emulated viewport width in px (200-4096)',minimum=200,maximum=4096),'height':P('integer','Emulated viewport height in px (200-4096)',minimum=200,maximum=4096),'deviceScaleFactor':P('number','Device pixel ratio (0 < dpr <= 4)',exclusiveMinimum=0,maximum=4),'mobile':P('boolean','Emulate mobile viewport and meta viewport behavior'),'touch':P('boolean','Enable touch event emulation'),'colorScheme':P('string','Emulate prefers-color-scheme CSS media feature',enum=['light','dark','no-preference']),'userAgent':P('string','Override navigator.userAgent and User-Agent HTTP header'),'locale':P('string','Override ICU locale (e.g. "ru-RU", "en-US")'),'timezone':P('string','Override timezone ID (e.g. "Europe/Moscow", "UTC")'),'offline':P('boolean','Emulate offline network state'),'latencyMs':P('integer','Simulated network latency in ms (0-30000)',minimum=0,maximum=30000),'downloadKbps':P('integer','Simulated download throughput in Kbps (1-1000000)',minimum=1,maximum=1000000),'uploadKbps':P('integer','Simulated upload throughput in Kbps (1-1000000)',minimum=1,maximum=1000000),'latitude':P('number','Emulated geolocation latitude (-90 to 90); requires longitude',minimum=-90,maximum=90),'longitude':P('number','Emulated geolocation longitude (-180 to 180); requires latitude',minimum=-180,maximum=180),'accuracy':P('number','Geolocation accuracy in meters (1-10000, default 50)',minimum=1,maximum=10000),'reset':P('boolean','Clear all active emulation overrides and detach debugger if unused')},[]),
 ('route_mock','Intercept matching HTTP requests on a tab via CDP Fetch: return mock response, fail with network error, or patch real server JSON response',{'tabId':TAB_ID,'urlPattern':P('string','Glob (* wildcards) or substring URL pattern to intercept'),'method':P('string','Optional HTTP method filter (e.g. GET, POST)'),'status':P('integer','HTTP status code (100-599, default 200)',minimum=100,maximum=599),'headers':P('object','Response headers map (defaults to JSON content-type)'),'body':P('string','Mock response body text'),'delayMs':P('integer','Artificial delay in ms before fulfilling (0-10000)',minimum=0,maximum=10000),'failReason':FAIL_REASONS,'stage':P('string','Interception stage: request (default) or response (modify real server response)',enum=['request','response']),'patchJson':P('object','JSON fields to merge into real server response when stage="response"'),'requestHeaders':P('object','Override outgoing request headers when continuing request')},['urlPattern']),
 ('route_clear','Stop intercepting HTTP requests on a tab and clear mock rules',{'tabId':TAB_ID},[]),
 ('audit_layout','Audit visible layout for horizontal overflow, broken images, clipped text, overlapping controls and small touch targets',{'tabId':TAB_ID,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'maxIssues':P('integer','Maximum issues per category (1-200, default 50)',minimum=1,maximum=200)},[]),
 ('wait','Pause execution for ms milliseconds (useful inside batch for animations/debounces)',{'tabId':TAB_ID,'ms':P('integer','Pause duration in milliseconds (0-30000, default 500)',minimum=0,maximum=30000)},['ms']),
 ('storage_get','Read localStorage and/or sessionStorage for the current page origin (sensitive keys and JWTs redacted by default)',{'tabId':TAB_ID,'type':P('string','Storage area to read (default both)',enum=['local','session','both']),'keys':P('array','Optional list of specific keys to read',items={'type':'string'}),'redact':P('boolean','Redact secret keys/JWT values (default true)')},[]),
 ('storage_set','Set, remove, or clear localStorage/sessionStorage for the current page origin',{'tabId':TAB_ID,'type':P('string','Target storage area (default local)',enum=['local','session']),'key':P('string','Storage key name'),'value':P('string','Value to store'),'remove':P('boolean','Remove the specified key instead of setting'),'clear':P('boolean','Clear all keys in the selected storage area')},[]),
 ('cookies_list','List Chrome cookies for the tab URL or domain (values redacted by default unless redact=false)',{'tabId':TAB_ID,'url':P('string','Filter cookies matching URL'),'domain':P('string','Filter cookies matching domain'),'redact':P('boolean','Redact cookie values (default true)')},[]),
 ('batch','Execute multiple browser tool calls in one request (runs single-IPC inside Chrome by default with DOM fusion, conditional when/optional/repeatUntil/parallel, {{$stepN.path}} templates, and optional afterSnapshot)',{'actions':P('array','Actions to run (1-30 steps)',minItems=1,maxItems=30,items=_step_item_schema(True)),'stopOnError':P('boolean','Stop batch on first failing step (default true)'),'animate':P('boolean','Await full visual cursor animations between steps (default false)'),'keepDebugger':P('boolean','Keep CDP debugger lease alive across batch steps to avoid attach/detach overhead (default true)'),'serverSide':P('boolean','Run inside Chrome service worker in a single IPC (default true; false uses step-by-step client loop)'),'fuseDom':P('boolean','Fuse consecutive pure-DOM steps into one content-script call (default true)'),'compact':COMPACT_OPT,'afterSnapshot':AFTER_SNAP},['actions']),
 # --- v2.0.0 tools ---
 ('extension_reload','Reload the Max Browser Chrome extension itself (via chrome.runtime.reload()) and wait for reconnection',{'waitForReconnect':P('boolean','Poll browser_status until reconnected (default true)')},[]),
 ('cookies_set','Set a Chrome cookie (including HttpOnly/Secure/SameSite) for the active tab URL or specified URL/domain',{'tabId':TAB_ID,'url':P('string','Target cookie URL (defaults to current tab URL)'),'name':P('string','Cookie name'),'value':P('string','Cookie value'),'domain':P('string','Cookie domain (e.g. .example.com)'),'path':P('string','Cookie path (default /)'),'secure':P('boolean','Whether cookie is Secure'),'httpOnly':P('boolean','Whether cookie is HttpOnly'),'sameSite':P('string','SameSite policy',enum=['no_restriction','lax','strict','unspecified']),'expirationDate':P('number','Unix timestamp in seconds when cookie expires')},['name','value']),
 ('cookies_delete','Delete a Chrome cookie by name for the tab URL or specified URL',{'tabId':TAB_ID,'url':P('string','Target cookie URL (defaults to current tab URL)'),'name':P('string','Cookie name to delete')},['name']),
 ('clipboard_read','Read text from the system clipboard via the controlled tab',{'tabId':TAB_ID,'maxChars':P('integer','Maximum characters to return (100-200000, default 50000)',minimum=100,maximum=200000)},[]),
 ('clipboard_write','Write text to the system clipboard via the controlled tab',{'tabId':TAB_ID,'text':P('string','Text string to copy to clipboard')},['text']),
 ('print_to_pdf','Render the tab to PDF via CDP Page.printToPDF (optional savePath to write directly to disk)',{'tabId':TAB_ID,'savePath':P('string','Optional local file path to save the PDF'),'returnBase64':P('boolean','Include base64 PDF data in response when savePath is set (default false)'),'landscape':P('boolean','Use landscape paper orientation (default false)'),'printBackground':P('boolean','Print CSS background colors and images (default true)'),'scale':P('number','Page scale factor (0.1-2.0, default 1.0)',minimum=0.1,maximum=2.0),'paperWidth':P('number','Paper width in inches (1-30, default 8.5)',minimum=1,maximum=30),'paperHeight':P('number','Paper height in inches (1-30, default 11)',minimum=1,maximum=30),'marginTop':P('number','Top margin in inches (0-5)',minimum=0,maximum=5),'marginBottom':P('number','Bottom margin in inches (0-5)',minimum=0,maximum=5),'marginLeft':P('number','Left margin in inches (0-5)',minimum=0,maximum=5),'marginRight':P('number','Right margin in inches (0-5)',minimum=0,maximum=5),'pageRanges':P('string','Paper ranges to print, e.g. "1-5, 8"')},[]),
 ('wait_network','Wait for a matching HTTP response or network completion/failure on the tab (auto-starts diagnostics)',{'tabId':TAB_ID,'urlPattern':P('string','Glob (* wildcards) or substring URL pattern to match'),'method':P('string','Optional HTTP method filter (e.g. GET, POST)'),'status':P('integer','Optional exact HTTP status code to match (100-599)',minimum=100,maximum=599),'captureBody':P('boolean','Capture and redact response body when available (default false)'),'sinceMs':P('integer','Look back up to this many ms in existing diagnostics buffer before waiting (0-30000, default 2000)',minimum=0,maximum=30000),'timeoutMs':TIMEOUT},['urlPattern']),
 ('wait_tab','Wait for a browser tab matching urlIncludes or openerTabId to appear',{'urlIncludes':P('string','Required substring in tab URL or pendingUrl'),'openerTabId':P('integer','Filter for tabs opened by this tab ID'),'includeExisting':P('boolean','Match already-open tabs as well as newly created tabs (default false)'),'timeoutMs':TIMEOUT},[]),
 ('windows_list','List open Chrome windows with IDs, bounds, state, and optional tab lists',{'populate':P('boolean','Include tabs array inside each window object (default false)')},[]),
 ('get_styles','Read computed CSS styles for a target element',{'tabId':TAB_ID,**TARGET,'properties':P('array','Optional list of CSS property names to read (defaults to common layout/typography styles)',items={'type':'string'})},[]),
 ('highlight_element','Visually highlight matched element(s) on the page with a colored box and label, or clear=true to remove',{'tabId':TAB_ID,**TARGET,'color':P('string','CSS border/accent color (default "#ef4444")'),'label':P('string','Optional badge label text'),'durationMs':P('integer','Auto-hide duration in ms (500-15000, default 3000)',minimum=500,maximum=15000),'clear':P('boolean','Remove any active highlight overlay')},[]),
 ('audit_responsive','Run layout audit across multiple viewport widths (default [375, 768, 1280, 1440]) in one call and restore overrides',{'tabId':TAB_ID,'widths':P('array','Viewport widths in px to audit (1-10 widths)',items={'type':'integer','minimum':280,'maximum':3840},minItems=1,maxItems=10),'height':P('integer','Viewport height in px during audit (400-2160, default 844)',minimum=400,maximum=2160),'maxIssues':P('integer','Maximum issues per category per width (1-100, default 25)',minimum=1,maximum=100)},[]),
 ('performance_metrics','Collect page navigation timing, Web Vitals (FP/FCP/LCP/CLS), slowest resources, DOM node count, and CDP heap/task metrics',{'tabId':TAB_ID},[]),
 ('safety_config','Inspect current Max Browser safety settings (paused state, readOnly mode, blocked/allowed domains)',{},[]),
 ('recorder_control','Start, stop, inspect, or clear user action recording into a ready-to-run batch JSON',{'action':P('string','Recorder action',enum=['start','stop','status','clear']),'tabId':TAB_ID},['action']),
 # --- v3.0.0 new tools ---
 ('browser_config','Read or update Max Browser runtime performance and token settings (speedMode, compactResponses, defaultScreenshotPreset, idleDebuggerLeaseMs)',{'speedMode':P('string','Cursor animation & indicator speed mode',enum=['visual','fast','instant']),'compactResponses':P('boolean','Default compact response mode across action tools'),'defaultScreenshotPreset':P('string','Default preset for screenshot calls without explicit format/preset',enum=['fast','normal','hd']),'idleDebuggerLeaseMs':P('integer','Keep CDP debugger attached cleanly for this many ms across standalone commands (0-30000)',minimum=0,maximum=30000)},[]),
 ('extract_structured','Extract HTML tables/ARIA grids into JSON rows automatically, or extract cards/lists using a rowSelector + fields mapping (supports selector@attr)',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'rowSelector':P('string','CSS selector for each item/row when using fields schema extraction'),'fields':P('object','Map of output field name -> CSS selector (or selector@attr, .@attr, . for row text)'),'includeHidden':P('boolean','Include hidden rows/tables (default false)'),'limit':P('integer','Maximum rows to extract (1-500, default 100)',minimum=1,maximum=500)},[]),
 ('fill_form','Smart multi-field form filler: matches inputs/selects/checkboxes/radios/contenteditable by label, placeholder, name, id, or ref in one call and optionally clicks submit',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'formSelector':P('string','Optional CSS selector scoping the target <form> or container'),'fields':P('object','Map of field label/name/placeholder/selector/ref -> value (string or boolean for checkbox/radio)'),'submit':P('anyOf','Click submit button afterwards (true for form submit button, or selector/text string)',anyOf=[{'type':'boolean'},{'type':'string'}]),'afterSnapshot':AFTER_SNAP,'compact':COMPACT_OPT,'verbose':VERBOSE_OPT},['fields']),
 ('page_fetch','Execute an HTTP fetch() inside the controlled tab MAIN world using its cookies/Origin/CSRF session; enforces safety policy & redacts secrets',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'url':P('string','Absolute or relative URL to fetch'),'method':P('string','HTTP method (default GET)',enum=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']),'headers':P('object','Optional HTTP request headers object'),'body':P('anyOf','Request body string or JSON object',anyOf=[{'type':'string'},{'type':'object'}]),'credentials':P('string','Fetch credentials mode (default include)',enum=['include','same-origin','omit']),'maxChars':P('integer','Maximum response body chars to return (500-100000, default 16000)',minimum=500,maximum=100000)},['url']),
 ('session_state','Export or import tab origin auth state (cookies + localStorage + sessionStorage) to an in-memory slot or encrypted-free local JSON file',{'action':P('string','Session action',enum=['export','import','list','delete']),'tabId':TAB_ID,'tab':TAB_SEL,'slot':P('string','Named in-memory session slot (default "default")'),'url':P('string','Optional explicit origin/URL for cookie scoping'),'savePath':P('string','Optional local JSON file path for export (chmod 600)'),'filePath':P('string','Optional local JSON file path for import'),'clearStorage':P('boolean','Clear localStorage/sessionStorage before importing (default false)')},['action']),
 ('scroll_to_text','Auto-scroll page or scrollable container step-by-step (supporting virtual lists / infinite scroll) until target text or selector appears',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'text':P('string','Text substring (or exact text with exact=true) to scroll until visible'),'selector':P('string','CSS selector to scroll until visible (alternative to text)'),'exact':P('boolean','Exact text match instead of substring (default false)'),'containerSelector':P('string','Optional CSS selector of scrollable container (defaults to window)'),'direction':P('string','Scroll direction (default down)',enum=['down','up','left','right']),'stepPx':P('integer','Pixels per scroll step (50-3000, default 500)',minimum=50,maximum=3000),'maxSteps':P('integer','Maximum scroll steps (1-50, default 15)',minimum=1,maximum=50),'delayMs':P('integer','Pause in ms between scroll steps for lazy rendering (20-2000, default 120)',minimum=20,maximum=2000)},[]),
 ('accessibility_audit','Audit WCAG contrast ratios, missing img alt, unlabeled controls, missing <html lang>, duplicate IDs, positive tabindex, and heading hierarchy',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'maxIssues':P('integer','Maximum issues per category (1-200, default 50)',minimum=1,maximum=200)},[]),
 ('visual_diff','Capture a visual baseline screenshot and compare pixels against a subsequent screenshot or local image file, returning diffPercent, changedRegions, and diffImage',{'action':P('string','Visual diff action',enum=['capture_baseline','compare','list','clear']),'tabId':TAB_ID,'tab':TAB_SEL,'slot':P('string','Named baseline slot (default "default")'),'beforePath':P('string','Optional local PNG/JPEG file path as before-image for compare'),'afterPath':P('string','Optional local PNG/JPEG file path as after-image for compare'),'savePath':P('string','Optional local PNG file path to write diffImage'),'returnImage':P('boolean','Include diffImage base64 / MCP image block in response (default false)'),'threshold':P('integer','Per-channel RGB diff threshold 0-255 (default 24)',minimum=0,maximum=255),'selector':P('string','Optional element CSS selector to scope baseline/current capture'),'ref':P('string','Optional element ref to scope baseline/current capture'),'region':REGION,'fullPage':P('boolean','Capture full scrollable page')},['action']),
 ('wait_until_js','Wait until a JavaScript expression returns truthy in page MAIN world and/or DOM mutations in a container stay quiet for quietMs',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'expression':P('string','JavaScript expression or statements that must return truthy'),'selector':P('string','Optional CSS selector scoping quietMs MutationObserver'),'quietMs':P('integer','Wait for zero DOM mutations for this many ms (50-10000)',minimum=50,maximum=10000),'pollMs':P('integer','Polling interval in ms for expression (40-1000, default 120)',minimum=40,maximum=1000),'timeoutMs':TIMEOUT},[]),
 ('network_har_export','Export captured diagnostics network log into standard HAR 1.2 JSON (in response or written to savePath)',{'tabId':TAB_ID,'urlPattern':P('string','Optional glob/substring URL filter'),'limit':P('integer','Maximum HTTP entries to include (1-500, default 200)',minimum=1,maximum=500),'savePath':P('string','Optional local file path to write the HAR JSON file'),'returnLog':P('boolean','Include full HAR log JSON in response when savePath is set (default false)')},[]),
 ('replay_request','Replay a recorded HTTP request from diagnostics inside the page context with optional URL, method, headers, or body overrides',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'requestId':P('string','Exact recorded requestId to replay'),'urlPattern':P('string','Glob/substring URL pattern matching the latest recorded request'),'url':P('string','Override destination URL'),'method':P('string','Override HTTP method',enum=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']),'headers':P('object','Additional or overridden HTTP headers'),'body':P('anyOf','Override request body string or JSON object',anyOf=[{'type':'string'},{'type':'object'}]),'maxChars':P('integer','Maximum response body chars to return (500-100000, default 16000)',minimum=500,maximum=100000)},[]),
 ('bookmarks_and_history','Search Chrome bookmarks and browser visit history by query (URL secrets redacted)',{'query':P('string','Search keywords (empty string returns recent items)'),'source':P('string','Which Chrome store to search (default both)',enum=['bookmarks','history','both']),'daysBack':P('integer','Restrict history search to recent N days (1-365)',minimum=1,maximum=365),'limit':P('integer','Maximum items per source (1-100, default 20)',minimum=1,maximum=100)},[]),
 ('page_markdown','Convert visible page/article content cleanly into structured Markdown (headings, links, lists, tables, code blocks)',{'tabId':TAB_ID,'tab':TAB_SEL,'frameId':P('integer','Target frame ID (default 0)',minimum=0),'mainOnly':P('boolean','Prioritize main/article element and skip nav/footer/aside (default true)'),'maxChars':P('integer','Maximum Markdown characters to return (500-200000, default 30000)',minimum=500,maximum=200000)},[]),
]

def validate(value,spec,path='arguments'):
 if 'anyOf' in spec:
  errors=[]
  for sub in spec['anyOf']:
   try:validate(value,sub,path);return
   except ValueError as e:errors.append(str(e))
  raise ValueError(errors[0] if errors else f'{path}: invalid value')
 kind=spec.get('type')
 checks={'object':lambda v:isinstance(v,dict),'array':lambda v:isinstance(v,list),'string':lambda v:isinstance(v,str),
         'integer':lambda v:isinstance(v,int) and not isinstance(v,bool),'number':lambda v:isinstance(v,(int,float)) and not isinstance(v,bool),
         'boolean':lambda v:isinstance(v,bool)}
 if kind in checks and not checks[kind](value):raise ValueError(f'{path}: expected {kind}')
 if 'enum' in spec and value not in spec['enum']:raise ValueError(f'{path}: invalid value')
 if kind=='object':
  for key in spec.get('required',[]):
   if key not in value:raise ValueError(f'{path}.{key}: required')
  for key,item in value.items():
   if key not in spec.get('properties',{}):
    if spec.get('additionalProperties') is False:raise ValueError(f'{path}.{key}: unknown argument')
   else:validate(item,spec['properties'][key],f'{path}.{key}')
 if kind=='array':
  if len(value)<spec.get('minItems',0) or len(value)>spec.get('maxItems',10000):raise ValueError(f'{path}: invalid array size')
  if spec.get('uniqueItems') and len({json.dumps(v,sort_keys=True) for v in value})!=len(value):raise ValueError(f'{path}: duplicate values')
  for i,item in enumerate(value):validate(item,spec.get('items',{}),f'{path}[{i}]')
 if kind in {'integer','number'}:
  if value<spec.get('minimum',float('-inf')) or value>spec.get('maximum',float('inf')):raise ValueError(f'{path}: out of range')
  if 'exclusiveMinimum' in spec and value<=spec['exclusiveMinimum']:raise ValueError(f'{path}: out of range')

TARGET_KEYS={'selector','ref','mark','text','role','name'}
INSERT_TEXT_TARGET_KEYS={'selector','ref','mark','role','name','targetText'}

def _is_sensitive_upload_path(resolved_str):
 if os.environ.get('MAX_BROWSER_ALLOW_SENSITIVE_UPLOAD')=='1':return False
 low=resolved_str.replace('\\','/').lower()
 if any(low==p.rstrip('/') or low.startswith(p) for p in SENSITIVE_UPLOAD_EXACT_PREFIXES):return True
 return any(sub in low for sub in SENSITIVE_UPLOAD_SUBPATHS)

def _check_safe_local_path(p_str,label='Path'):
 sp=Path(p_str)
 resolved_parent=str(sp.parent.resolve())
 if _is_sensitive_upload_path(str(sp)) or _is_sensitive_upload_path(resolved_parent):
  raise ValueError(f'{label} in sensitive directory is blocked: {p_str}')

def _has_templates(obj):
 if isinstance(obj,str):return '{{$' in obj
 if isinstance(obj,list):return any(_has_templates(x) for x in obj)
 if isinstance(obj,dict):return any(_has_templates(v) for v in obj.values())
 return False

_TPL_RX=re.compile(r'\{\{\$(step\d+|prev)((?:\.[A-Za-z0-9_-]+|\[\d+\])*)\}\}')

def _lookup_path(root,path_expr):
 cur=root
 for part in re.findall(r'\.([A-Za-z0-9_-]+)|\[(\d+)\]',path_expr):
  key,idx=part
  if key:
   if not isinstance(cur,dict) or key not in cur:raise ValueError(f'Template path key not found: {key}')
   cur=cur[key]
  else:
   i=int(idx)
   if not isinstance(cur,list) or i>=len(cur):raise ValueError(f'Template path index out of range: [{i}]')
   cur=cur[i]
 return cur

def _resolve_templates(obj,step_results):
 if isinstance(obj,list):return [_resolve_templates(x,step_results) for x in obj]
 if isinstance(obj,dict):return {k:_resolve_templates(v,step_results) for k,v in obj.items()}
 if not isinstance(obj,str) or '{{$' not in obj:return obj
 def resolve_ref_expr(ref_name,path_expr):
  if ref_name=='prev':
   if not step_results:raise ValueError('{{$prev...}} used on first step')
   base=step_results[-1]
  else:
   num=int(ref_name[4:])
   if num<1 or num>len(step_results):raise ValueError(f'Template step{num} has not completed yet')
   base=step_results[num-1]
  return _lookup_path(base,path_expr)
 m=_TPL_RX.fullmatch(obj)
 if m:
  return resolve_ref_expr(m.group(1),m.group(2))
 return _TPL_RX.sub(lambda mm:str(resolve_ref_expr(mm.group(1),mm.group(2))),obj)

def _validate_batch_step(act,path_prefix):
 has_name='name' in act and isinstance(act['name'],str)
 has_par='parallel' in act and isinstance(act['parallel'],list)
 if has_name==has_par:
  raise ValueError(f'{path_prefix}: specify either name or parallel array')
 if has_par:
  for j,sub in enumerate(act['parallel']):
   _validate_batch_step(sub,f'{path_prefix}.parallel[{j}]')
  return
 sub_name=act['name']
 if sub_name=='batch':raise ValueError(f'{path_prefix}: nested batch is not allowed')
 sub_args=act.get('arguments',{})
 if _has_templates(sub_args):
  if next((t for t in TOOLS if t[0]==sub_name),None) is None:raise ValueError('Unknown tool: '+sub_name)
  return
 validate_tool(sub_name,sub_args)

def validate_tool(name,args):
 tool=next((t for t in TOOLS if t[0]==name),None)
 if tool is None:raise ValueError('Unknown tool: '+name)
 validate(args,schema(tool[2],tool[3]))
 if name=='batch':
  for idx,act in enumerate(args['actions']):
   _validate_batch_step(act,f'actions[{idx}]')
  return
 if 'expect' in args:
  expected=args['expect'];has_target=any(k in expected for k in TARGET_KEYS)
  if not has_target and not any(k in expected for k in {'url','urlIncludes','textIncludes'}):raise ValueError('expect requires an observable outcome')
  if any(k in expected for k in {'value','checked','state'}) and not has_target:raise ValueError('expect value/checked/state requires an element target')
 if name in {'click','hover','get_styles'}:
  if not any(k in args for k in TARGET_KEYS) and (name=='get_styles' or 'coordinate' not in args):raise ValueError('Specify an element target' + ('' if name=='get_styles' else ' or coordinate'))
 elif name=='highlight_element':
  if not args.get('clear') and not any(k in args for k in TARGET_KEYS):raise ValueError('Specify an element target or clear=true')
 elif name=='drag':
  has_start=any(k in args for k in ('startCoordinate','startSelector','startRef'))
  has_end=any(k in args for k in ('coordinate','targetSelector','targetRef'))
  if not has_start or not has_end:raise ValueError('Specify drag start (startCoordinate/startSelector/startRef) and end (coordinate/targetSelector/targetRef)')
 elif name=='find_elements':
  if not args.get('query') and not any(k in args for k in TARGET_KEYS):raise ValueError('Specify query or an element target')
 elif name=='insert_text':
  has_it_target=any(k in args for k in INSERT_TEXT_TARGET_KEYS)
  if not has_it_target and any(k in args for k in ('nth','exact')):
   raise ValueError('Specify an element target')
 elif name in page_tools|{'wait_change','upload_files'} and not (name in {'scroll','read_dom'} or (name=='press_key' and not any(k in args for k in TARGET if k!='frameId'))):
  if not any(k in args for k in TARGET_KEYS):raise ValueError('Specify an element target')
 if name=='tabs_move' and (('index' in args)==('offset' in args)):raise ValueError('Specify exactly one of index or offset')
 if name=='upload_files':
  for filename in args['files']:
   path=Path(filename)
   if not path.is_absolute():raise ValueError('Upload requires an existing absolute file path: '+filename)
   resolved=path.resolve()
   if not resolved.is_file():raise ValueError('Upload requires an existing absolute file path: '+filename)
   if _is_sensitive_upload_path(str(resolved)):raise ValueError('Upload of sensitive path is blocked: '+filename)
 if name in {'screenshot','print_to_pdf','network_har_export'} and args.get('savePath'):
  _check_safe_local_path(args['savePath'],'Saving')
 if name=='session_state':
  if args.get('savePath'):_check_safe_local_path(args['savePath'],'Saving session')
  if args.get('filePath'):
   fp=Path(args['filePath'])
   if not fp.is_file():raise ValueError('Session file does not exist: '+args['filePath'])
   if _is_sensitive_upload_path(str(fp.resolve())):raise ValueError('Reading sensitive path is blocked: '+args['filePath'])
 if name=='visual_diff':
  if args.get('savePath'):_check_safe_local_path(args['savePath'],'Saving diff')
  for k in ('beforePath','afterPath'):
   if args.get(k):
    p=Path(args[k])
    if not p.is_file():raise ValueError(f'{k} does not exist: {args[k]}')
    if _is_sensitive_upload_path(str(p.resolve())):raise ValueError(f'Reading sensitive path is blocked: {args[k]}')
 if name=='scroll_to_text' and not args.get('text') and not args.get('selector'):
  raise ValueError('Specify text or selector for scroll_to_text')
 if name=='wait_until_js' and not args.get('expression') and not args.get('quietMs'):
  raise ValueError('Specify expression or quietMs for wait_until_js')
 if name=='replay_request' and not args.get('requestId') and not args.get('urlPattern'):
  raise ValueError('Specify requestId or urlPattern for replay_request')
 if name=='download_start' and 'filename' in args:
  path=Path(args['filename'])
  if not args['filename'] or path.is_absolute() or '..' in path.parts:raise ValueError('Download filename must be relative to Downloads without ..')
 if name=='storage_set' and not args.get('clear') and not args.get('key'):
  raise ValueError('Specify key or clear=true')
 if name=='emulate':
  if ('latitude' in args)!=('longitude' in args):raise ValueError('Specify both latitude and longitude together')
  if not any(k in args for k in {'width','height','deviceScaleFactor','mobile','touch','colorScheme','userAgent','locale','timezone','offline','latencyMs','downloadKbps','uploadKbps','latitude','longitude','reset'}):
   raise ValueError('Specify at least one emulation parameter or reset=true')

def compute_timeout(name,args):
 extra=0.0
 for key in ('timeoutMs','actionTimeoutMs','ms','stableMs','durationMs'):
  val=args.get(key)
  if isinstance(val,(int,float)) and not isinstance(val,bool):extra+=val/1000.0
 exp=args.get('expect')
 if isinstance(exp,dict):
  exp_ms=exp.get('timeoutMs')
  extra+=(exp_ms/1000.0) if isinstance(exp_ms,(int,float)) and not isinstance(exp_ms,bool) else 10.0
 if name in {'wait_for','wait_change','wait_page','download_wait','wait_network','wait_tab','wait_until_js'} and 'timeoutMs' not in args:
  extra+=15.0
 if name=='scroll_to_text':
  extra+=max(5.0,(args.get('maxSteps',15)*args.get('delayMs',120))/1000.0)
 if name=='audit_responsive':
  extra+=len(args.get('widths') or [375,768,1280,1440])*3.0
 if name=='batch':
  extra+=max(25.0,len(args.get('actions') or [])*3.0)
 return max(45.0,min(120.0,20.0+extra))

def _send_browser(name,args,meta=None,timeout_sec=None):
 req_timeout=timeout_sec if timeout_sec is not None else compute_timeout(name,args)
 payload={'name':name,'arguments':args,'clientId':CLIENT_ID,'timeoutSec':req_timeout}
 if meta:payload['meta']=meta
 with socket.socket(socket.AF_UNIX) as client:
  client.settimeout(req_timeout+5.0)
  try:client.connect(SOCKET)
  except OSError as e:
   if name=='browser_status':return {'version':VERSION,'connected':False,'socketExists':Path(SOCKET).exists(),'error':str(e),'recovery':'Reload Max Browser in chrome://extensions and click its toolbar button.'}
   raise RuntimeError('Max Browser is not connected. Reload it in chrome://extensions and click its toolbar button.') from e
  client.sendall(json.dumps(payload).encode()+b'\n')
  raw=client.makefile('rb').readline(64*1024*1024)
  if not raw:
   raise RuntimeError('Max Browser connection closed while waiting for response. Reload Max Browser in chrome://extensions if needed.')
  d=json.loads(raw)
  if 'error' in d:raise RuntimeError(d['error'])
  return d['result']

def _save_b64_file(path_str,b64_data):
 p=Path(path_str)
 p.parent.mkdir(parents=True,exist_ok=True)
 raw=base64.b64decode(b64_data)
 p.write_bytes(raw)
 return len(raw)

def _run_single_tool(name,args,meta):
 if name=='extension_reload':
  res=_send_browser(name,args,meta=meta)
  if args.get('waitForReconnect',True):
   deadline=time.monotonic()+8.0
   time.sleep(0.35)
   while time.monotonic()<deadline:
    try:
     st=_send_browser('browser_status',{},meta={'clientId':CLIENT_ID},timeout_sec=2.0)
     if st.get('connected'):return {'reloaded':True,'status':st}
    except Exception:
     pass
    time.sleep(0.25)
  return res

 send_args=args
 if name=='session_state':
  if args.get('action')=='export' and args.get('savePath'):
   send_args={**args,'returnData':True}
  elif args.get('action')=='import' and args.get('filePath'):
   data=json.loads(Path(args['filePath']).read_text(encoding='utf-8'))
   send_args={k:v for k,v in args.items() if k!='filePath'}
   send_args['data']=data
 elif name=='visual_diff' and args.get('action')=='compare':
  if args.get('beforePath') or args.get('afterPath'):
   send_args={k:v for k,v in args.items() if k not in ('beforePath','afterPath')}
   if args.get('beforePath'):send_args['beforeBase64']=base64.b64encode(Path(args['beforePath']).read_bytes()).decode()
   if args.get('afterPath'):send_args['afterBase64']=base64.b64encode(Path(args['afterPath']).read_bytes()).decode()

 res=_send_browser(name,send_args,meta=meta)

 if name=='session_state' and args.get('action')=='export' and args.get('savePath') and isinstance(res,dict) and 'data' in res:
  sp=Path(args['savePath'])
  sp.parent.mkdir(parents=True,exist_ok=True)
  raw_txt=json.dumps(res.pop('data'),ensure_ascii=False,indent=2)
  sp.write_text(raw_txt,encoding='utf-8')
  os.chmod(sp,0o600)
  res['savedPath']=str(sp)
  res['sizeBytes']=len(raw_txt.encode('utf-8'))
  return res

 if name=='network_har_export' and args.get('savePath') and isinstance(res,dict) and 'log' in res:
  sp=Path(args['savePath'])
  sp.parent.mkdir(parents=True,exist_ok=True)
  har_obj={'log':res['log']} if args.get('returnLog') else {'log':res.pop('log')}
  raw_txt=json.dumps(har_obj,ensure_ascii=False,indent=2)
  sp.write_text(raw_txt,encoding='utf-8')
  res['savedPath']=str(sp)
  res['sizeBytes']=len(raw_txt.encode('utf-8'))
  return res

 if name=='visual_diff' and args.get('savePath') and isinstance(res,dict) and 'diffImage' in res:
  sz=_save_b64_file(args['savePath'],res['diffImage'])
  res['savedPath']=str(Path(args['savePath']))
  res['sizeBytes']=sz
  if not args.get('returnImage'):res.pop('diffImage',None)
  return res

 if name=='print_to_pdf' and args.get('savePath') and isinstance(res,dict) and 'data' in res:
  size_bytes=_save_b64_file(args['savePath'],res['data'])
  out={'savedPath':str(Path(args['savePath'])),'sizeBytes':size_bytes}
  if args.get('returnBase64'):out['data']=res['data']
  return out

 if name=='screenshot' and args.get('savePath') and isinstance(res,dict):
  save_p=Path(args['savePath'])
  if 'tiles' in res and isinstance(res['tiles'],list):
   saved_files=[]
   ext=save_p.suffix or '.png'
   for idx,tile in enumerate(res['tiles'],1):
    tp=save_p.with_name(f'{save_p.stem}-tile-{idx}{ext}')
    sz=_save_b64_file(str(tp),tile['image'])
    tile_info={'tile':idx,'path':str(tp),'sizeBytes':sz,'scrollY':tile.get('scrollY')}
    if not args.get('returnImage'):tile.pop('image',None)
    saved_files.append(tile_info)
   res['savedFiles']=saved_files
  elif 'image' in res:
   sz=_save_b64_file(str(save_p),res['image'])
   res['savedPath']=str(save_p)
   res['sizeBytes']=sz
   if not args.get('returnImage'):res.pop('image',None)
 return res

def _batch_needs_client_loop(args):
 if args.get('serverSide') is False:return True
 for act in args.get('actions',[]):
  if 'parallel' in act:
   for sub in act['parallel']:
    if sub.get('name')=='extension_reload' or any(k in (sub.get('arguments') or {}) for k in ('savePath','filePath','beforePath','afterPath')):
     return True
  else:
   sa=act.get('arguments') or {}
   if act.get('name')=='extension_reload' or any(k in sa for k in ('savePath','filePath','beforePath','afterPath')):
    return True
 return False

def browser(name,args):
 validate_tool(name,args)
 if name=='batch':
  if not _batch_needs_client_loop(args):
   batch_meta={'clientId':CLIENT_ID,'fast':not bool(args.get('animate',False))}
   return _send_browser('_batch_exec',args,meta=batch_meta,timeout_sec=compute_timeout('batch',args))
  stop_on_error=args.get('stopOnError',True)
  animate=bool(args.get('animate',False))
  keep_dbg=args.get('keepDebugger',True)
  step_meta={'clientId':CLIENT_ID,'fast':not animate,'leaseMs':8000 if keep_dbg else 0}
  results=[]
  step_outputs=[]
  ran_any=False
  try:
   for idx,act in enumerate(args['actions']):
    if 'parallel' in act:
     raise ValueError('parallel steps require serverSide=true batch mode')
    sub_name=act['name'];raw_args=act.get('arguments',{})
    retries=int(act.get('retries',0) or 0)
    retry_delay=float(act.get('retryDelayMs',250) or 250)/1000.0
    ran_any=True
    last_err=None
    ok_res=None
    succeeded=False
    for attempt in range(retries+1):
     try:
      sub_args=_resolve_templates(raw_args,step_outputs) if _has_templates(raw_args) else raw_args
      validate_tool(sub_name,sub_args)
      ok_res=_run_single_tool(sub_name,sub_args,meta={**step_meta,'fast':bool(sub_args.get('fast',not animate))})
      succeeded=True
      break
     except Exception as e:
      last_err=e
      if attempt<retries:time.sleep(retry_delay)
    if succeeded:
     step_outputs.append(ok_res)
     results.append({'step':idx+1,'tool':sub_name,'ok':True,'result':ok_res})
    else:
     step_outputs.append({'error':str(last_err)})
     if act.get('optional'):
      results.append({'step':idx+1,'tool':sub_name,'ok':True,'skipped':True,'error':str(last_err)})
     else:
      results.append({'step':idx+1,'tool':sub_name,'ok':False,'error':str(last_err)})
      if stop_on_error:break
  finally:
   if keep_dbg and ran_any:
    try:_send_browser('_release_leases',{},meta={'clientId':CLIENT_ID},timeout_sec=2.0)
    except Exception:pass
  return {'steps':results,'completed':sum(1 for r in results if r['ok']),'total':len(args['actions']),'hadError':any(not r['ok'] for r in results)}
 meta={'clientId':CLIENT_ID}
 if args.get('fast'):meta['fast']=True
 return _run_single_tool(name,args,meta=meta)

def format_mcp_content(name,value):
 if name=='screenshot':
  if isinstance(value,dict) and 'tiles' in value:
   items=[]
   meta={k:v for k,v in value.items() if k!='tiles'}
   if meta:items.append({'type':'text','text':json.dumps(meta,ensure_ascii=False)})
   for idx,tile in enumerate(value['tiles'],1):
    tmeta={k:v for k,v in tile.items() if k!='image'}
    items.append({'type':'text','text':json.dumps({'tile':idx,**tmeta},ensure_ascii=False)})
    if 'image' in tile:items.append({'type':'image','data':tile['image'],'mimeType':tile['mimeType']})
   return items
  if isinstance(value,dict) and 'image' in value:
   meta={k:v for k,v in value.items() if k!='image'}
   items=[{'type':'image','data':value['image'],'mimeType':value['mimeType']}]
   if meta:items.append({'type':'text','text':json.dumps(meta,ensure_ascii=False)})
   return items
  return [{'type':'text','text':json.dumps(value,ensure_ascii=False)}]
 if name=='visual_diff' and isinstance(value,dict) and 'diffImage' in value:
  meta={k:v for k,v in value.items() if k!='diffImage'}
  return [{'type':'image','data':value['diffImage'],'mimeType':value.get('mimeType','image/png')},{'type':'text','text':json.dumps(meta,ensure_ascii=False)}]
 if name=='batch':
  items=[]
  for step in value['steps']:
   if step['ok'] and step['tool']=='screenshot' and isinstance(step['result'],dict) and 'image' in step['result']:
    img=step['result']
    meta={k:v for k,v in img.items() if k!='image'}
    items.append({'type':'text','text':json.dumps({'step':step['step'],'tool':'screenshot','ok':True,**meta},ensure_ascii=False)})
    items.append({'type':'image','data':img['image'],'mimeType':img['mimeType']})
   else:
    items.append({'type':'text','text':json.dumps(step,ensure_ascii=False)})
  return items
 return [{'type':'text','text':json.dumps(value,ensure_ascii=False)}]

def mcp(profile=None):
 active_profile=profile or get_profile()
 visible_tools=get_profile_tools(active_profile)
 all_tool_names={t[0] for t in TOOLS}
 write_lock=threading.Lock()
 def send_json(obj):
  line=json.dumps(obj)
  with write_lock:print(line,flush=True)
 def run_call(rid,name,args):
  try:
   value=browser(name,args)
   is_err=bool(name=='batch' and value.get('hadError'))
   send_json({'jsonrpc':'2.0','id':rid,'result':{'content':format_mcp_content(name,value),**({'isError':True} if is_err else {})}})
  except Exception as e:
   send_json({'jsonrpc':'2.0','id':rid,'result':{'isError':True,'content':[{'type':'text','text':str(e)}]}})
 with ThreadPoolExecutor(max_workers=16) as executor:
  for line in sys.stdin:
   req=None
   try:
    req=json.loads(line);method=req.get('method');rid=req.get('id')
    if rid is None:continue
    if method=='initialize':
     proto=(req.get('params') or {}).get('protocolVersion') or '2024-11-05'
     send_json({'jsonrpc':'2.0','id':rid,'result':{'protocolVersion':proto,'capabilities':{'tools':{}},'serverInfo':{'name':'Max Browser','version':VERSION}}})
    elif method=='ping':send_json({'jsonrpc':'2.0','id':rid,'result':{}})
    elif method=='tools/list':send_json({'jsonrpc':'2.0','id':rid,'result':{'tools':[{'name':n,'description':d,'inputSchema':schema(p,r)} for n,d,p,r in visible_tools]}})
    elif method=='tools/call':
     params=req['params'];name=params['name'];args=params.get('arguments',{})
     if name not in all_tool_names:raise ValueError('Unknown tool')
     executor.submit(run_call,rid,name,args)
    else:
     send_json({'jsonrpc':'2.0','id':rid,'error':{'code':-32601,'message':'Method not found'}})
   except Exception as e:
    if req and req.get('id') is not None:send_json({'jsonrpc':'2.0','id':req['id'],'error':{'code':-32603,'message':str(e)}})

if __name__=='__main__':
 if '--native' in sys.argv:native()
 elif '--call' in sys.argv:print(json.dumps(browser(sys.argv[2],json.loads(sys.argv[3] if len(sys.argv)>3 else '{}')),ensure_ascii=False))
 else:mcp()
