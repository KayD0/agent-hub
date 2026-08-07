import * as path from "node:path";
import * as vscode from "vscode";
import { AuthenticationManager } from "../application/authentication-manager";
import { SessionManager } from "../application/session-manager";
import { ManagedSession } from "../domain/session";
import { isStringArray, parseAnswers } from "./webview-messages";

type SessionViewModel = Pick<ManagedSession, "id" | "title" | "status" | "currentActivity" | "finalResult" | "autoApprove" | "pendingInteraction"> & { repositoryGroupIds: string[] };
type RepositoryGroupFilter = { id: string; name: string; rootPath: string };

interface WebviewMessage {
  type?: unknown;
  sessionId?: unknown;
  text?: unknown;
  decision?: unknown;
  answers?: unknown;
  sessionIds?: unknown;
  enabled?: unknown;
}

export class SessionWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private lastSnapshot?: string;
  private readonly subscription: { dispose(): void };
  private readonly authSubscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly authentication: AuthenticationManager,
    private readonly openSession: (sessionId: string) => void,
    private readonly listRepositoryGroups: () => readonly RepositoryGroupFilter[],
    private readonly showError: (error: unknown) => void,
  ) {
    this.subscription = manager.onDidChange(() => this.refresh());
    this.authSubscription = authentication.onDidChange(() => this.refresh());
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.lastSnapshot = undefined;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    });
    view.onDidDispose(() => { this.view = undefined; });
    // Register message handlers before loading the document. The webview posts
    // `ready` immediately, so assigning HTML first can lose that first message.
    view.webview.html = renderHtml(view.webview);
  }

  public refresh(force = false): void {
    const message = {
      type: "sessions",
      sessions: this.snapshot(),
      authentication: this.authentication.getState(),
      repositoryGroups: this.listRepositoryGroups(),
    };
    const serialized = JSON.stringify(message);
    if (!force && serialized === this.lastSnapshot) return;
    this.lastSnapshot = serialized;
    void this.view?.webview.postMessage(message);
  }

  public dispose(): void {
    this.subscription.dispose();
    this.authSubscription.dispose();
  }

  private snapshot(): SessionViewModel[] {
    const groups = this.listRepositoryGroups();
    return this.manager.list().map(({ id, title, status, currentActivity, finalResult, autoApprove, pendingInteraction, cwd }) => ({
      id,
      title,
      status,
      currentActivity: status === "starting" || status === "running" ? "処理中" : currentActivity,
      finalResult,
      autoApprove,
      pendingInteraction,
      repositoryGroupIds: groups.filter((group) => isInside(cwd, group.rootPath)).map((group) => group.id),
    }));
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (message.type === "ready") {
      this.refresh(true);
      return;
    }
    try {
      if (message.type === "loginBrowser") {
        const login = await this.authentication.startBrowserLogin();
        const opened = await vscode.env.openExternal(vscode.Uri.parse(login.authUrl));
        if (!opened) {
          const fallback = await this.authentication.startDeviceCodeLogin();
          await vscode.env.openExternal(vscode.Uri.parse(fallback.verificationUrl));
        }
        return;
      }
      if (message.type === "loginDeviceCode") {
        const login = await this.authentication.startDeviceCodeLogin();
        await vscode.env.clipboard.writeText(login.userCode);
        await vscode.env.openExternal(vscode.Uri.parse(login.verificationUrl));
        return;
      }
      if (message.type === "cancelLogin") {
        await this.authentication.cancelLogin();
        return;
      }
      if (message.type === "logout") {
        await this.authentication.logout();
        return;
      }
    } catch (error) {
      this.showError(error);
      return;
    }
    if (message.type === "reorder" && isStringArray(message.sessionIds)) {
      try {
        await this.manager.reorder(message.sessionIds);
      } catch (error) {
        this.showError(error);
      }
      return;
    }
    if (!sessionId) return;
    try {
      if (message.type === "send" && typeof message.text === "string" && message.text.trim()) {
        await this.manager.sendMessage(sessionId, message.text.trim());
      } else if (message.type === "autoApprove" && typeof message.enabled === "boolean") {
        this.manager.setAutoApprove(sessionId, message.enabled);
      } else if (message.type === "open") {
        this.manager.markRead(sessionId);
        this.openSession(sessionId);
      } else if (message.type === "interrupt") {
        await this.manager.interrupt(sessionId);
      } else if (message.type === "remove") {
        await this.manager.remove(sessionId);
      } else if (message.type === "approval" && isDecision(message.decision)) {
        this.manager.resolveApproval(sessionId, message.decision);
      } else if (message.type === "answer") {
        const answers = parseAnswers(message.answers);
        if (answers) this.manager.resolveInput(sessionId, answers);
      }
    } catch (error) {
      this.showError(error);
    }
  }
}

function isDecision(value: unknown): value is "accept" | "acceptForSession" | "decline" {
  return value === "accept" || value === "acceptForSession" || value === "decline";
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = randomNonce();
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    *{box-sizing:border-box}body{padding:0 8px 12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
    .auth{margin:10px 0 0;padding:10px;border:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));border-radius:4px}.auth.error{border-color:var(--vscode-inputValidation-errorBorder)}.auth.authenticated{display:flex;align-items:center;gap:8px;white-space:nowrap}.auth.authenticated .auth-title{flex:none}.auth.authenticated .auth-detail{min-width:0;flex:1;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.auth.authenticated .actions{flex:none;margin:0}.auth-title{font-weight:600}.auth-detail{margin:5px 0;color:var(--vscode-descriptionForeground);word-break:break-word}.auth-code{display:block;margin:8px 0;padding:7px;text-align:center;font:600 16px var(--vscode-editor-font-family);letter-spacing:2px;background:var(--vscode-textCodeBlock-background);user-select:all}.folder-filters{display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:7px 10px;border:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));border-top:0;border-radius:0 0 4px 4px}.filter-title{flex:none;color:var(--vscode-descriptionForeground);font-size:11px}.filter-options{display:flex;min-width:0;flex-wrap:wrap;gap:5px 10px}.folder-filter{display:flex;align-items:center;gap:4px;min-width:0;font-size:11px}.folder-filter input{margin:0}.folder-filter span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .empty{color:var(--vscode-descriptionForeground);padding:16px 4px}.sessions-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;margin-top:12px}.session{min-width:0;border:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));border-left:3px solid var(--vscode-descriptionForeground);border-radius:4px;padding:8px;background:var(--vscode-sideBar-background)}
    .session-head{display:flex;align-items:flex-start;gap:6px}.session-main{min-width:0;flex:1}.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity{margin-top:3px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity.busy{display:flex;align-items:center;gap:5px}.spinner{width:11px;height:11px;flex:none;border:2px solid var(--vscode-progressBar-background,var(--vscode-charts-blue));border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.status{font-size:10px;padding:1px 5px;border:1px solid currentColor;border-radius:8px;color:var(--vscode-descriptionForeground)}.result-popover{position:relative;display:inline-block}.result{display:none;position:absolute;z-index:10;top:50%;left:calc(100% + 7px);width:min(320px,calc(100vw - 32px));padding:8px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-textCodeBlock-background));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));box-shadow:0 2px 8px var(--vscode-widget-shadow);transform:translateY(-50%);white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}.result::before{content:'';position:absolute;top:50%;right:100%;border:6px solid transparent;border-right-color:var(--vscode-widget-border,var(--vscode-panel-border));transform:translateY(-50%)}.result::after{content:'';position:absolute;top:0;right:100%;bottom:0;width:8px}.result-popover.is-open .result,.result-toggle:focus + .result{display:block}.result-toggle{margin-top:7px;border:0;padding:3px 6px;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer}.result-toggle:hover,.result-toggle:focus{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.result-label{display:block;margin-bottom:4px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:600}
    .session[data-status="ready"],.session[data-status="completed"]{border-left-color:var(--vscode-testing-iconPassed,var(--vscode-charts-green))}.session[data-status="starting"],.session[data-status="running"]{border-left-color:var(--vscode-progressBar-background,var(--vscode-charts-blue))}.session[data-status="waiting_for_approval"],.session[data-status="waiting_for_input"],.session[data-status="interrupted"]{border-left-color:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow))}.session[data-status="failed"],.session[data-status="disconnected"]{border-left-color:var(--vscode-errorForeground,var(--vscode-charts-red))}
    .session[data-status="ready"] .status,.session[data-status="completed"] .status{color:var(--vscode-testing-iconPassed,var(--vscode-charts-green))}.session[data-status="starting"] .status,.session[data-status="running"] .status{color:var(--vscode-progressBar-background,var(--vscode-charts-blue))}.session[data-status="waiting_for_approval"] .status,.session[data-status="waiting_for_input"] .status,.session[data-status="interrupted"] .status{color:var(--vscode-inputValidation-warningForeground,var(--vscode-charts-yellow))}.session[data-status="failed"] .status,.session[data-status="disconnected"] .status{color:var(--vscode-errorForeground,var(--vscode-charts-red))}
    .drag-handle,.icon-button{flex:none;border:0;padding:2px 5px;background:transparent;color:var(--vscode-foreground)}.drag-handle{cursor:grab;user-select:none}.drag-handle:active{cursor:grabbing}.drag-handle:hover,.drag-handle:focus,.icon-button:hover{outline:none;background:var(--vscode-toolbar-hoverBackground)}.session.dragging{opacity:.55}form{display:flex;gap:5px;margin-top:8px}textarea{min-width:0;flex:1;resize:vertical;min-height:30px;max-height:100px;padding:5px 6px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    .actions button,.header-action{border:0;padding:4px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}.actions button:hover,.header-action:hover{background:var(--vscode-button-hoverBackground)}.actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.actions button.secondary,.header-action.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.auto-control{display:flex;align-items:center;gap:3px;font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}.auto-control input{margin:0}.auto-control:has(input:checked){color:var(--vscode-inputValidation-warningForeground,var(--vscode-charts-yellow));font-weight:600}.input-request{display:block;padding:8px;border:1px solid var(--vscode-inputValidation-warningBorder,var(--vscode-panel-border));border-radius:3px}.input-question{margin:0 0 9px;padding:0;border:0}.input-question legend{font-weight:600;margin-bottom:4px}.input-option{display:flex;gap:5px;margin:4px 0}.input-option span{color:var(--vscode-descriptionForeground)}.input-other{width:100%;padding:5px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
    @media (prefers-reduced-motion:reduce){.spinner{animation:none}}@media (min-width:520px){.sessions-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (min-width:820px){.sessions-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (min-width:1100px){.sessions-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
  </style>
</head>
<body><main id="sessions" aria-live="polite"></main>
<script nonce="${nonce}">
  const vscode=acquireVsCodeApi();const root=document.getElementById('sessions');const openResults=new Set();const resultCloseTimers=new Map();const savedFilterIds=Array.isArray(vscode.getState()?.repositoryGroupFilterIds)?vscode.getState().repositoryGroupFilterIds:[];const selectedRepositoryGroupIds=new Set(savedFilterIds);let sessions=[];let repositoryGroups=[];let authentication={status:'checking'};let draggedSessionId;let composingSessionId;let renderPending=false;
  const labels={ready:'待機中',starting:'開始中',running:'実行中',waiting_for_approval:'承認待ち',waiting_for_input:'入力待ち',completed:'完了',failed:'失敗',interrupted:'中断',disconnected:'切断'};
  function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
  function button(label,title,action,secondary=false){const node=el('button',secondary?'secondary':'',label);node.type='button';node.title=title;node.setAttribute('aria-label',title);node.addEventListener('click',action);return node}
  function renderAuthentication(){const auth=el('section','auth'+(authentication.status==='error'?' error':'')+(authentication.status==='authenticated'?' authenticated':''));const title=el('div','auth-title');const detail=el('p','auth-detail');const actions=el('div','actions');if(authentication.status==='checking'){title.textContent='認証状態を確認中';detail.textContent='Codexアカウントを確認しています。'}else if(authentication.status==='authenticated'){title.textContent='Codexにログイン済み';detail.textContent=[authentication.email,authentication.planType].filter(Boolean).join(' · ')||authentication.authMode||'利用可能';detail.title=detail.textContent;actions.append(button('ログアウト','Codexからログアウト',()=>vscode.postMessage({type:'logout'}),true))}else if(authentication.status==='logging_in'){title.textContent='ログインを待っています';detail.textContent=authentication.userCode?'表示されたコードをブラウザで入力してください。':'ブラウザで認証を完了してください。';if(authentication.userCode)auth.append(title,detail,el('code','auth-code',authentication.userCode));else auth.append(title,detail);actions.append(button('キャンセル','ログインをキャンセル',()=>vscode.postMessage({type:'cancelLogin'}),true));auth.append(actions);return auth}else{title.textContent=authentication.status==='error'?'ログインできませんでした':'Codexへのログインが必要です';detail.textContent=authentication.error||'ChatGPTアカウントでログインしてください。';actions.append(button('ブラウザでログイン','ChatGPTでログイン',()=>vscode.postMessage({type:'loginBrowser'})));actions.append(button('デバイスコード','デバイスコードでログイン',()=>vscode.postMessage({type:'loginDeviceCode'}),true))}auth.append(title,detail);if(actions.childElementCount)auth.append(actions);return auth}
  function renderFolderFilters(){for(const id of [...selectedRepositoryGroupIds])if(!repositoryGroups.some(group=>group.id===id))selectedRepositoryGroupIds.delete(id);const section=el('section','folder-filters');section.setAttribute('aria-label','セッションのフォルダフィルター');section.append(el('span','filter-title','フォルダ'));const options=el('div','filter-options');for(const group of repositoryGroups){const label=el('label','folder-filter');label.title=group.rootPath;const input=el('input');input.type='checkbox';input.checked=selectedRepositoryGroupIds.has(group.id);input.setAttribute('aria-label',group.name+'のセッションを表示');input.addEventListener('change',()=>{if(input.checked)selectedRepositoryGroupIds.add(group.id);else selectedRepositoryGroupIds.delete(group.id);vscode.setState({...vscode.getState(),repositoryGroupFilterIds:[...selectedRepositoryGroupIds]});renderSessions()});label.append(input,el('span','',group.name));options.append(label)}section.append(options);return section}
  function publishOrder(grid){const visibleIds=[...grid.querySelectorAll('.session')].map(card=>card.dataset.sessionId);const visibleSet=new Set(visibleIds);let index=0;const sessionIds=sessions.map(session=>visibleSet.has(session.id)?visibleIds[index++]:session.id);vscode.postMessage({type:'reorder',sessionIds})}
  function renderInputRequest(session,pending){const form=el('form','input-request');for(const question of pending.questions){const field=el('fieldset','input-question');field.dataset.questionId=question.id;field.append(el('legend','',question.header||question.question));if(question.header&&question.question)field.append(el('div','auth-detail',question.question));const inputType=question.isMultiSelect?'checkbox':'radio';for(const option of question.options||[]){const label=el('label','input-option');const input=el('input');input.type=inputType;input.name='question-'+question.id;input.value=option.label;input.required=!question.isMultiSelect;label.append(input,document.createTextNode(option.label));if(option.description)label.append(el('span','',option.description));field.append(label)}if(question.isOther||!(question.options||[]).length){const other=el('input','input-other');other.type=question.isSecret?'password':'text';other.placeholder=question.isOther?'その他の回答':'回答を入力';other.setAttribute('aria-label',question.question);other.dataset.other='true';if(!(question.options||[]).length)other.required=true;field.append(other)}form.append(field)}form.append(button('回答を送信','すべての回答を送信',()=>form.requestSubmit()));form.addEventListener('submit',event=>{event.preventDefault();const answers={};for(const field of form.querySelectorAll('.input-question')){const selected=[...field.querySelectorAll('input:checked')].map(input=>input.value);const other=field.querySelector('[data-other]')?.value.trim();if(other)selected.push(other);if(!selected.length){field.querySelector('input')?.focus();return}answers[field.dataset.questionId]=selected}vscode.postMessage({type:'answer',sessionId:session.id,answers})});return form}
  function render(){const drafts=new Map([...document.querySelectorAll('textarea[data-session]')].map(x=>[x.dataset.session,x.value]));const active=document.activeElement?.dataset?.session;root.replaceChildren();root.append(renderAuthentication());if(authentication.status!=='authenticated')return;if(repositoryGroups.length)root.append(renderFolderFilters());const visibleSessions=selectedRepositoryGroupIds.size?sessions.filter(session=>session.repositoryGroupIds?.some(id=>selectedRepositoryGroupIds.has(id))):sessions;if(!visibleSessions.length){root.append(el('p','empty',sessions.length?'選択したフォルダのセッションはありません。':'セッションはまだありません。'));return}const grid=el('div','sessions-grid');
      for(const session of visibleSessions){const card=el('article','session');card.dataset.status=session.status;card.dataset.sessionId=session.id;const head=el('div','session-head');const handle=el('span','drag-handle','⠿');handle.draggable=true;handle.tabIndex=0;handle.title='ドラッグまたは矢印キーで並べ替え';handle.setAttribute('role','button');handle.setAttribute('aria-label',session.title+'を並べ替え');handle.addEventListener('dragstart',event=>{draggedSessionId=session.id;card.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',session.id)});handle.addEventListener('dragend',()=>{draggedSessionId=undefined;card.classList.remove('dragging')});handle.addEventListener('keydown',event=>{const backward=event.key==='ArrowUp'||event.key==='ArrowLeft';const forward=event.key==='ArrowDown'||event.key==='ArrowRight';if(!backward&&!forward)return;event.preventDefault();const sibling=backward?card.previousElementSibling:card.nextElementSibling;if(!sibling)return;if(backward)sibling.before(card);else sibling.after(card);publishOrder(grid);handle.focus()});const main=el('div','session-main');main.append(el('div','title',session.title));if(session.currentActivity){const activity=el('div','activity'+(['starting','running'].includes(session.status)?' busy':''));if(['starting','running'].includes(session.status)){const spinner=el('span','spinner');spinner.setAttribute('aria-hidden','true');activity.append(spinner,document.createTextNode(session.currentActivity))}else activity.textContent=session.currentActivity;main.append(activity)}head.append(handle,main,el('span','status',labels[session.status]));if(['starting','running','waiting_for_input'].includes(session.status)){const interrupt=button('中断','処理を中断',()=>vscode.postMessage({type:'interrupt',sessionId:session.id}),true);interrupt.classList.add('header-action');head.append(interrupt)}if(['ready','completed','failed','interrupted','disconnected'].includes(session.status)){const remove=button('×','一覧から削除',()=>vscode.postMessage({type:'remove',sessionId:session.id}));remove.className='icon-button';head.append(remove)}const open=button('↗','詳細を開く',()=>vscode.postMessage({type:'open',sessionId:session.id}));open.className='icon-button';head.append(open);card.append(head);
        const form=el('form');const input=el('textarea');input.dataset.session=session.id;input.rows=1;input.placeholder='このセッションへ指示...';input.title='Enterで送信、Ctrl+Enter（MacはCommand+Enter）で改行';input.setAttribute('aria-label',session.title+'への指示');input.value=drafts.get(session.id)||'';form.append(input);form.addEventListener('submit',event=>{event.preventDefault();const text=input.value.trim();if(!text)return;vscode.postMessage({type:'send',sessionId:session.id,text});input.value=''});input.addEventListener('compositionstart',()=>{composingSessionId=session.id});input.addEventListener('compositionend',()=>{composingSessionId=undefined;if(renderPending){renderPending=false;queueMicrotask(renderSessions)}});input.addEventListener('keydown',event=>{if(event.key!=='Enter'||event.isComposing||event.keyCode===229||composingSessionId===session.id)return;event.preventDefault();if(event.ctrlKey||event.metaKey){input.setRangeText('\\n',input.selectionStart,input.selectionEnd,'end');return}form.requestSubmit()});card.append(form);
        const actions=el('div','actions');const pending=session.pendingInteraction;if(pending?.kind==='approval'){actions.append(button('今回のみ許可','今回のみ許可',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'accept'})));if(pending.allowForSession)actions.append(button('セッションで許可','このセッションで許可',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'acceptForSession'})));actions.append(button('拒否','拒否',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'decline'}),true))}
        if(pending?.kind==='input')card.append(renderInputRequest(session,pending));
        if(actions.childElementCount)card.append(actions);grid.append(card)}grid.addEventListener('dragover',event=>{if(!draggedSessionId)return;const target=event.target.closest('.session');const dragged=grid.querySelector('[data-session-id="'+CSS.escape(draggedSessionId)+'"]');if(!target||!dragged||target===dragged)return;event.preventDefault();const rect=target.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;target[after?'after':'before'](dragged)});grid.addEventListener('drop',event=>{if(!draggedSessionId)return;event.preventDefault();publishOrder(grid)});root.append(grid)
    if(active){const input=root.querySelector('textarea[data-session="'+CSS.escape(active)+'"]');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length)}}}
  function openResult(sessionId,popover){clearTimeout(resultCloseTimers.get(sessionId));resultCloseTimers.delete(sessionId);openResults.add(sessionId);popover.classList.add('is-open')}
  function closeResultLater(sessionId){clearTimeout(resultCloseTimers.get(sessionId));resultCloseTimers.set(sessionId,setTimeout(()=>{resultCloseTimers.delete(sessionId);openResults.delete(sessionId);root.querySelector('.result-popover[data-result-session="'+CSS.escape(sessionId)+'"]')?.classList.remove('is-open')},250))}
  function preserveHoveredResult(){const popover=root.querySelector('.result-popover:hover');const sessionId=popover?.dataset.resultSession;if(sessionId)openResult(sessionId,popover)}
  function decorateResults(){for(const session of sessions){const card=root.querySelector('[data-session-id="'+CSS.escape(session.id)+'"]');if(!card||!session.finalResult)continue;const resultId='result-'+session.id.replace(/[^a-zA-Z0-9_-]/g,'-');const popover=el('div','result-popover');popover.dataset.resultSession=session.id;if(openResults.has(session.id))popover.classList.add('is-open');const toggle=el('button','result-toggle','最終結果');toggle.type='button';toggle.setAttribute('aria-label','最終結果を表示');toggle.setAttribute('aria-describedby',resultId);const result=el('div','result');result.id=resultId;result.setAttribute('role','tooltip');result.append(el('span','result-label','最終結果'),document.createTextNode(session.finalResult));popover.addEventListener('mouseenter',()=>openResult(session.id,popover));popover.addEventListener('mouseleave',()=>closeResultLater(session.id));popover.append(toggle,result);card.insertBefore(popover,card.querySelector('form'))}}
  function decorateAutoControls(){for(const session of sessions){const card=root.querySelector('[data-session-id="'+CSS.escape(session.id)+'"]');const head=card?.querySelector('.session-head');if(!head)continue;const label=el('label','auto-control');label.title='ポリシーに一致する承認要求だけをこのセッションで自動許可';const input=el('input');input.type='checkbox';input.checked=session.autoApprove;input.setAttribute('aria-label',session.title+'のポリシーAuto承認');input.addEventListener('change',()=>vscode.postMessage({type:'autoApprove',sessionId:session.id,enabled:input.checked}));label.append(input,document.createTextNode('Auto'));head.insertBefore(label,head.querySelector('.icon-button'))}}
  function captureFocus(){const active=document.activeElement;const card=active?.closest?.('.session');if(!card)return null;return{sessionId:card.dataset.sessionId,ariaLabel:active===card?null:active.getAttribute('aria-label')}}
  function restoreFocus(state){if(!state)return;const card=root.querySelector('[data-session-id="'+CSS.escape(state.sessionId)+'"]');if(!card)return;const target=state.ariaLabel?card.querySelector('[aria-label="'+CSS.escape(state.ariaLabel)+'"]'):card;(target||card).focus()}
  function renderSessions(){const focus=captureFocus();preserveHoveredResult();render();decorateResults();decorateAutoControls();restoreFocus(focus)}
  window.addEventListener('message',event=>{if(event.data?.type==='sessions'){sessions=event.data.sessions;repositoryGroups=event.data.repositoryGroups||[];authentication=event.data.authentication||{status:'checking'};if(composingSessionId){renderPending=true;return}renderSessions()}});
  vscode.postMessage({type:'ready'});
</script></body></html>`;
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
