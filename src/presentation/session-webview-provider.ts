import * as path from "node:path";
import * as vscode from "vscode";
import { AuthenticationManager } from "../application/authentication-manager";
import { SessionManager } from "../application/session-manager";
import { AuthenticationState } from "../domain/authentication";
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
  private static readonly repositoryFilterKey = "agentHub.repositoryGroupFilterIds";
  private view?: vscode.WebviewView;
  private lastSnapshot?: string;
  private readonly selectedRepositoryGroupIds: Set<string>;
  private readonly subscription: { dispose(): void };
  private readonly authSubscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly authentication: AuthenticationManager,
    private readonly openSession: (sessionId: string) => void,
    private readonly listRepositoryGroups: () => readonly RepositoryGroupFilter[],
    private readonly state: vscode.Memento,
    private readonly showError: (error: unknown) => void,
  ) {
    this.selectedRepositoryGroupIds = new Set(state.get<string[]>(SessionWebviewProvider.repositoryFilterKey, []));
    this.subscription = manager.onDidChange(() => this.refresh());
    this.authSubscription = authentication.onDidChange(() => this.refresh());
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.lastSnapshot = undefined;
    this.updateAuthenticationChrome();
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
    this.updateAuthenticationChrome();
    const groups = this.listRepositoryGroups();
    for (const id of this.selectedRepositoryGroupIds) {
      if (!groups.some((group) => group.id === id)) this.selectedRepositoryGroupIds.delete(id);
    }
    this.updateTitleContexts(groups.length > 0);
    const message = {
      type: "sessions",
      sessions: this.snapshot(),
      authentication: this.authentication.getState(),
      repositoryGroupFilterIds: [...this.selectedRepositoryGroupIds],
    };
    const serialized = JSON.stringify(message);
    if (!force && serialized === this.lastSnapshot) return;
    this.lastSnapshot = serialized;
    void this.view?.webview.postMessage(message);
  }

  public async selectRepositoryGroups(): Promise<void> {
    const groups = this.listRepositoryGroups();
    const selected = await vscode.window.showQuickPick(groups.map((group) => ({
      label: group.name,
      description: group.rootPath,
      id: group.id,
      picked: this.selectedRepositoryGroupIds.has(group.id),
    })), {
      canPickMany: true,
      placeHolder: "表示するフォルダを選択（未選択ですべて表示）",
      title: "Codex Sessionsのフォルダフィルター",
    });
    if (!selected) return;
    this.selectedRepositoryGroupIds.clear();
    for (const item of selected) this.selectedRepositoryGroupIds.add(item.id);
    await this.state.update(SessionWebviewProvider.repositoryFilterKey, [...this.selectedRepositoryGroupIds]);
    this.refresh(true);
  }

  public setAllAutoApprove(enabled: boolean): void {
    this.manager.setAllAutoApprove(enabled);
    this.updateTitleContexts(this.listRepositoryGroups().length > 0);
  }

  public dispose(): void {
    this.subscription.dispose();
    this.authSubscription.dispose();
  }

  private updateAuthenticationChrome(): void {
    const state = this.authentication.getState();
    if (this.view) this.view.description = authenticationDescription(state);
    void vscode.commands.executeCommand("setContext", "agentHub.authenticationStatus", state.status);
  }

  private updateTitleContexts(hasRepositoryGroups: boolean): void {
    const sessions = this.manager.list();
    const allAutoEnabled = sessions.length > 0 && sessions.every((session) => session.autoApprove);
    void vscode.commands.executeCommand("setContext", "agentHub.hasRepositoryGroups", hasRepositoryGroups);
    void vscode.commands.executeCommand("setContext", "agentHub.repositoryFilterActive", this.selectedRepositoryGroupIds.size > 0);
    void vscode.commands.executeCommand("setContext", "agentHub.bulkAutoEnabled", allAutoEnabled);
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
    if (message.type === "reorder" && isStringArray(message.sessionIds)) {
      try {
        await this.manager.reorder(message.sessionIds);
      } catch (error) {
        this.showError(error);
      }
      return;
    }
    if (message.type === "autoApproveAll" && typeof message.enabled === "boolean") {
      this.manager.setAllAutoApprove(message.enabled);
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

function authenticationDescription(state: AuthenticationState): string | undefined {
  if (state.status === "authenticated") return undefined;
  if (state.status === "logging_in") return "ログイン中";
  if (state.status === "checking") return "認証確認中";
  if (state.status === "error") return "認証エラー";
  return "未ログイン";
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
    .app-header{position:sticky;z-index:30;top:0;padding-top:6px;background:var(--vscode-sideBar-background)}.auth{margin:0;padding:7px 8px;border:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));border-radius:4px}.auth.error{border-color:var(--vscode-inputValidation-errorBorder)}.auth.authenticated{display:flex;align-items:center;gap:8px;white-space:nowrap}.auth.authenticated .auth-title{flex:none}.auth.authenticated .auth-detail{min-width:0;flex:1;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.auth.authenticated .actions{flex:none;margin:0}.auth-title{font-weight:600}.auth-detail{margin:5px 0;color:var(--vscode-descriptionForeground);word-break:break-word}.auth-code{display:block;margin:8px 0;padding:7px;text-align:center;font:600 16px var(--vscode-editor-font-family);letter-spacing:2px;background:var(--vscode-textCodeBlock-background);user-select:all}
    @property --session-border-angle{syntax:"<angle>";inherits:false;initial-value:0deg}.empty{color:var(--vscode-descriptionForeground);padding:16px 4px}.sessions-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;margin-top:12px}.session{position:relative;min-width:0;border:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));border-left:3px solid var(--vscode-descriptionForeground);border-radius:4px;padding:8px;background:var(--vscode-sideBar-background);font-size:12px}.session[data-status="starting"]::before,.session[data-status="running"]::before{content:"";position:absolute;z-index:1;inset:-1px;padding:2px;border-radius:5px;background:conic-gradient(from var(--session-border-angle),transparent 0deg,transparent 285deg,var(--vscode-progressBar-background,var(--vscode-charts-blue)) 325deg,transparent 360deg);pointer-events:none;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:session-border-run 1.3s linear infinite}@keyframes session-border-run{to{--session-border-angle:360deg}}
    .session-head{display:flex;align-items:flex-start;gap:6px}.session-main{min-width:0;flex:1}.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status{font-size:10px;padding:1px 5px;border:1px solid currentColor;border-radius:8px;color:var(--vscode-descriptionForeground)}.result-popover{position:relative;display:inline-block}.result{display:none;position:absolute;z-index:10;top:50%;left:calc(100% + 7px);width:min(320px,calc(100vw - 32px));padding:8px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-textCodeBlock-background));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));box-shadow:0 2px 8px var(--vscode-widget-shadow);transform:translateY(-50%);white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}.result::before{content:'';position:absolute;top:50%;right:100%;border:6px solid transparent;border-right-color:var(--vscode-widget-border,var(--vscode-panel-border));transform:translateY(-50%)}.result::after{content:'';position:absolute;top:0;right:100%;bottom:0;width:8px}.result-popover.is-open .result,.result-toggle:focus + .result{display:block}.result-toggle{margin-top:7px;border:0;padding:3px 6px;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer}.result-toggle:hover,.result-toggle:focus{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.result-label{display:block;margin-bottom:4px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:600}
    .session[data-status="ready"],.session[data-status="completed"]{border-left-color:var(--vscode-testing-iconPassed,var(--vscode-charts-green))}.session[data-status="starting"],.session[data-status="running"]{border-left-color:var(--vscode-progressBar-background,var(--vscode-charts-blue))}.session[data-status="waiting_for_approval"],.session[data-status="waiting_for_input"],.session[data-status="interrupted"]{border-left-color:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow))}.session[data-status="failed"],.session[data-status="disconnected"]{border-left-color:var(--vscode-errorForeground,var(--vscode-charts-red))}
    .session[data-status="ready"] .status,.session[data-status="completed"] .status{color:var(--vscode-testing-iconPassed,var(--vscode-charts-green))}.session[data-status="starting"] .status,.session[data-status="running"] .status,.session[data-status="starting"] .header-action,.session[data-status="running"] .header-action{color:var(--vscode-progressBar-background,var(--vscode-charts-blue))}.session[data-status="waiting_for_approval"] .status,.session[data-status="waiting_for_input"] .status,.session[data-status="interrupted"] .status,.session[data-status="waiting_for_input"] .header-action{color:var(--vscode-inputValidation-warningForeground,var(--vscode-charts-yellow))}.session[data-status="failed"] .status,.session[data-status="disconnected"] .status{color:var(--vscode-errorForeground,var(--vscode-charts-red))}
    .drag-handle,.icon-button{flex:none;border:0;padding:2px 5px;background:transparent;color:var(--vscode-foreground)}.drag-handle{cursor:grab;user-select:none}.drag-handle:active{cursor:grabbing}.drag-handle:hover,.drag-handle:focus,.icon-button:hover{outline:none;background:var(--vscode-toolbar-hoverBackground)}.session.dragging{opacity:.55}form{display:flex;gap:5px;margin-top:8px}textarea{min-width:0;flex:1;resize:vertical;min-height:30px;max-height:100px;padding:5px 6px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.card-quick-actions{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:7px}.card-input-popover{position:relative;display:inline-block}.card-input-toggle,.card-open{border:0;padding:3px 6px;background:transparent;color:var(--vscode-descriptionForeground);font-size:10px;cursor:pointer}.card-input-toggle:hover,.card-input-toggle:focus,.card-open:hover,.card-open:focus{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.card-quick-actions .result-toggle{margin-top:0;font-size:10px}.card-input-form{display:none;position:absolute;z-index:12;top:50%;left:calc(100% + 7px);width:min(320px,calc(100vw - 32px));margin:0;padding:8px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-sideBar-background));box-shadow:0 2px 8px var(--vscode-widget-shadow);transform:translateY(-50%)}.card-input-form::before{content:'';position:absolute;top:0;right:100%;bottom:0;width:8px}.card-input-popover:hover .card-input-form,.card-input-popover:focus-within .card-input-form,.card-input-popover.is-open .card-input-form{display:flex}.card-input-form textarea{min-height:60px}.card-input-form button{align-self:flex-end;border:0;padding:4px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}.card-input-form button:hover{background:var(--vscode-button-hoverBackground)}
    .actions button{border:0;padding:4px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}.actions button:hover{background:var(--vscode-button-hoverBackground)}.header-action{flex:none;border:1px solid currentColor;border-radius:8px;padding:1px 5px;background:transparent;font-size:10px;cursor:pointer}.header-action:hover,.header-action:focus{background:var(--vscode-list-hoverBackground);outline:none}.actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.actions button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.auto-control{display:flex;align-self:center;align-items:center;gap:3px;font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}.auto-control input{margin:0}.auto-control:has(input:checked){color:var(--vscode-inputValidation-warningForeground,var(--vscode-charts-yellow));font-weight:600}.input-request{display:block;padding:8px;border:1px solid var(--vscode-inputValidation-warningBorder,var(--vscode-panel-border));border-radius:3px}.input-question{margin:0 0 9px;padding:0;border:0}.input-question legend{font-weight:600;margin-bottom:4px}.input-option{display:flex;gap:5px;margin:4px 0}.input-option span{color:var(--vscode-descriptionForeground)}.input-other{width:100%;padding:5px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
    @media (prefers-reduced-motion:reduce){.session[data-status="starting"]::before,.session[data-status="running"]::before{animation:none;background:var(--vscode-progressBar-background,var(--vscode-charts-blue))}}@media (min-width:520px){.sessions-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (min-width:820px){.sessions-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (min-width:1100px){.sessions-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
  </style>
</head>
<body><main id="sessions" aria-live="polite"></main>
<script nonce="${nonce}">
  const vscode=acquireVsCodeApi();const root=document.getElementById('sessions');const openResults=new Set();const resultCloseTimers=new Map();const inputCloseTimers=new Map();const selectedRepositoryGroupIds=new Set();let sessions=[];let authentication={status:'checking'};let draggedSessionId;let composingSessionId;let renderPending=false;
  const labels={ready:'待機中',starting:'開始中',running:'実行中',waiting_for_approval:'承認待ち',waiting_for_input:'入力待ち',completed:'完了',failed:'失敗',interrupted:'中断',disconnected:'切断'};
  function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
  function button(label,title,action,secondary=false){const node=el('button',secondary?'secondary':'',label);node.type='button';node.title=title;node.setAttribute('aria-label',title);node.addEventListener('click',action);return node}
  function publishOrder(grid){const visibleIds=[...grid.querySelectorAll('.session')].map(card=>card.dataset.sessionId);const visibleSet=new Set(visibleIds);let index=0;const sessionIds=sessions.map(session=>visibleSet.has(session.id)?visibleIds[index++]:session.id);vscode.postMessage({type:'reorder',sessionIds})}
  function renderInputRequest(session,pending){const form=el('form','input-request');for(const question of pending.questions){const field=el('fieldset','input-question');field.dataset.questionId=question.id;field.append(el('legend','',question.header||question.question));if(question.header&&question.question)field.append(el('div','auth-detail',question.question));const inputType=question.isMultiSelect?'checkbox':'radio';for(const option of question.options||[]){const label=el('label','input-option');const input=el('input');input.type=inputType;input.name='question-'+question.id;input.value=option.label;input.required=!question.isMultiSelect;label.append(input,document.createTextNode(option.label));if(option.description)label.append(el('span','',option.description));field.append(label)}if(question.isOther||!(question.options||[]).length){const other=el('input','input-other');other.type=question.isSecret?'password':'text';other.placeholder=question.isOther?'その他の回答':'回答を入力';other.setAttribute('aria-label',question.question);other.dataset.other='true';if(!(question.options||[]).length)other.required=true;field.append(other)}form.append(field)}form.append(button('回答を送信','すべての回答を送信',()=>form.requestSubmit()));form.addEventListener('submit',event=>{event.preventDefault();const answers={};for(const field of form.querySelectorAll('.input-question')){const selected=[...field.querySelectorAll('input:checked')].map(input=>input.value);const other=field.querySelector('[data-other]')?.value.trim();if(other)selected.push(other);if(!selected.length){field.querySelector('input')?.focus();return}answers[field.dataset.questionId]=selected}vscode.postMessage({type:'answer',sessionId:session.id,answers})});return form}
  function render(){const drafts=new Map([...document.querySelectorAll('textarea[data-session]')].map(x=>[x.dataset.session,x.value]));const active=document.activeElement?.dataset?.session;root.replaceChildren();if(authentication.status!=='authenticated')return;const visibleSessions=selectedRepositoryGroupIds.size?sessions.filter(session=>session.status==='waiting_for_approval'||session.repositoryGroupIds?.some(id=>selectedRepositoryGroupIds.has(id))):sessions;if(!visibleSessions.length){root.append(el('p','empty',sessions.length?'選択したフォルダのセッションはありません。':'セッションはまだありません。'));return}const grid=el('div','sessions-grid');
      for(const session of visibleSessions){const card=el('article','session');card.dataset.status=session.status;card.dataset.sessionId=session.id;const head=el('div','session-head');const handle=el('span','drag-handle','⠿');handle.draggable=true;handle.tabIndex=0;handle.title='ドラッグまたは矢印キーで並べ替え';handle.setAttribute('role','button');handle.setAttribute('aria-label',session.title+'を並べ替え');handle.addEventListener('dragstart',event=>{draggedSessionId=session.id;card.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',session.id)});handle.addEventListener('dragend',()=>{draggedSessionId=undefined;card.classList.remove('dragging')});handle.addEventListener('keydown',event=>{const backward=event.key==='ArrowUp'||event.key==='ArrowLeft';const forward=event.key==='ArrowDown'||event.key==='ArrowRight';if(!backward&&!forward)return;event.preventDefault();const sibling=backward?card.previousElementSibling:card.nextElementSibling;if(!sibling)return;if(backward)sibling.before(card);else sibling.after(card);publishOrder(grid);handle.focus()});const main=el('div','session-main');main.append(el('div','title',session.title));head.append(handle,main,el('span','status',labels[session.status]));if(['starting','running','waiting_for_input'].includes(session.status)){const interrupt=button('中断','処理を中断',()=>vscode.postMessage({type:'interrupt',sessionId:session.id}),true);interrupt.classList.add('header-action');head.append(interrupt)}if(['ready','completed','failed','interrupted','disconnected'].includes(session.status)){const remove=button('×','一覧から削除',()=>vscode.postMessage({type:'remove',sessionId:session.id}));remove.className='icon-button';head.append(remove)}card.append(head);
        const quickActions=el('div','card-quick-actions');const inputPopover=el('div','card-input-popover');const inputToggle=el('button','card-input-toggle','追加入力');inputToggle.type='button';inputToggle.setAttribute('aria-haspopup','dialog');inputToggle.setAttribute('aria-label',session.title+'へ追加入力');const form=el('form','card-input-form');form.setAttribute('role','dialog');form.setAttribute('aria-label',session.title+'への追加入力');const input=el('textarea');input.dataset.session=session.id;input.rows=2;input.placeholder='このセッションへ指示...';input.title='Enterで送信、Ctrl+Enter（MacはCommand+Enter）で改行';input.setAttribute('aria-label',session.title+'への指示');input.value=drafts.get(session.id)||'';const send=el('button','','送信');send.type='submit';send.title='指示を送信';send.setAttribute('aria-label','指示を送信');form.append(input,send);form.addEventListener('submit',event=>{event.preventDefault();const text=input.value.trim();if(!text)return;vscode.postMessage({type:'send',sessionId:session.id,text});input.value=''});input.addEventListener('compositionstart',()=>{composingSessionId=session.id});input.addEventListener('compositionend',()=>{composingSessionId=undefined;if(renderPending){renderPending=false;queueMicrotask(renderSessions)}});input.addEventListener('keydown',event=>{if(event.key!=='Enter'||event.isComposing||event.keyCode===229||composingSessionId===session.id)return;event.preventDefault();if(event.ctrlKey||event.metaKey){input.setRangeText('\\n',input.selectionStart,input.selectionEnd,'end');return}form.requestSubmit()});inputPopover.addEventListener('mouseenter',()=>openCardInput(session.id,inputPopover));inputPopover.addEventListener('mouseleave',()=>closeCardInputLater(session.id,inputPopover));inputPopover.addEventListener('focusin',()=>openCardInput(session.id,inputPopover));inputPopover.addEventListener('focusout',()=>closeCardInputLater(session.id,inputPopover));inputPopover.addEventListener('pointermove',event=>{if(event.pointerType!=='mouse'||document.activeElement===input||composingSessionId)return;input.focus({preventScroll:true});if(input.selectionStart===0&&input.selectionEnd===0)input.setSelectionRange(input.value.length,input.value.length)});inputPopover.append(inputToggle,form);const open=button('↗','詳細を開く',()=>vscode.postMessage({type:'open',sessionId:session.id}));open.className='card-open';quickActions.append(inputPopover,open);card.append(quickActions);
        const actions=el('div','actions');const pending=session.pendingInteraction;if(pending?.kind==='approval'){actions.append(button('今回のみ許可','今回のみ許可',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'accept'})));if(pending.allowForSession)actions.append(button('セッションで許可','このセッションで許可',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'acceptForSession'})));actions.append(button('拒否','拒否',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'decline'}),true))}
        if(pending?.kind==='input')card.append(renderInputRequest(session,pending));
        if(actions.childElementCount)card.append(actions);grid.append(card)}grid.addEventListener('dragover',event=>{if(!draggedSessionId)return;const target=event.target.closest('.session');const dragged=grid.querySelector('[data-session-id="'+CSS.escape(draggedSessionId)+'"]');if(!target||!dragged||target===dragged)return;event.preventDefault();const rect=target.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;target[after?'after':'before'](dragged)});grid.addEventListener('drop',event=>{if(!draggedSessionId)return;event.preventDefault();publishOrder(grid)});root.append(grid)
    if(active){const input=root.querySelector('textarea[data-session="'+CSS.escape(active)+'"]');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length)}}}
  function openResult(sessionId,popover){clearTimeout(resultCloseTimers.get(sessionId));resultCloseTimers.delete(sessionId);openResults.add(sessionId);popover.classList.add('is-open')}
  function closeResultLater(sessionId){clearTimeout(resultCloseTimers.get(sessionId));resultCloseTimers.set(sessionId,setTimeout(()=>{resultCloseTimers.delete(sessionId);openResults.delete(sessionId);root.querySelector('.result-popover[data-result-session="'+CSS.escape(sessionId)+'"]')?.classList.remove('is-open')},250))}
  function openCardInput(sessionId,popover){clearTimeout(inputCloseTimers.get(sessionId));inputCloseTimers.delete(sessionId);popover.classList.add('is-open')}
  function closeCardInputLater(sessionId,popover){clearTimeout(inputCloseTimers.get(sessionId));inputCloseTimers.set(sessionId,setTimeout(()=>{inputCloseTimers.delete(sessionId);if(!popover.matches(':hover')&&!popover.matches(':focus-within'))popover.classList.remove('is-open')},250))}
  function preserveHoveredResult(){const popover=root.querySelector('.result-popover:hover');const sessionId=popover?.dataset.resultSession;if(sessionId)openResult(sessionId,popover)}
  function decorateResults(){for(const session of sessions){const card=root.querySelector('[data-session-id="'+CSS.escape(session.id)+'"]');const quickActions=card?.querySelector('.card-quick-actions');const inputPopover=quickActions?.querySelector('.card-input-popover');if(!quickActions||!inputPopover||!session.finalResult)continue;const resultId='result-'+session.id.replace(/[^a-zA-Z0-9_-]/g,'-');const popover=el('div','result-popover');popover.dataset.resultSession=session.id;if(openResults.has(session.id))popover.classList.add('is-open');const toggle=el('button','result-toggle','最終結果');toggle.type='button';toggle.setAttribute('aria-label','最終結果を表示');toggle.setAttribute('aria-describedby',resultId);const result=el('div','result');result.id=resultId;result.setAttribute('role','tooltip');result.append(el('span','result-label','最終結果'),document.createTextNode(session.finalResult));popover.addEventListener('mouseenter',()=>openResult(session.id,popover));popover.addEventListener('mouseleave',()=>closeResultLater(session.id));popover.append(toggle,result);quickActions.insertBefore(popover,inputPopover)}}
  function decorateAutoControls(){for(const session of sessions){const card=root.querySelector('[data-session-id="'+CSS.escape(session.id)+'"]');const head=card?.querySelector('.session-head');if(!head)continue;const label=el('label','auto-control');label.title='ポリシーに一致する承認要求だけをこのセッションで自動許可';const input=el('input');input.type='checkbox';input.checked=session.autoApprove;input.setAttribute('aria-label',session.title+'のポリシーAuto承認');input.addEventListener('change',()=>vscode.postMessage({type:'autoApprove',sessionId:session.id,enabled:input.checked}));label.append(input,document.createTextNode('Auto'));head.insertBefore(label,head.querySelector('.icon-button'))}}
  function captureFocus(){const active=document.activeElement;const card=active?.closest?.('.session');if(!card)return null;return{sessionId:card.dataset.sessionId,ariaLabel:active===card?null:active.getAttribute('aria-label')}}
  function restoreFocus(state){if(!state)return;const card=root.querySelector('[data-session-id="'+CSS.escape(state.sessionId)+'"]');if(!card)return;const target=state.ariaLabel?card.querySelector('[aria-label="'+CSS.escape(state.ariaLabel)+'"]'):card;(target||card).focus()}
  function renderSessions(){const focus=captureFocus();preserveHoveredResult();render();decorateResults();decorateAutoControls();restoreFocus(focus)}
  window.addEventListener('message',event=>{if(event.data?.type==='sessions'){sessions=event.data.sessions;selectedRepositoryGroupIds.clear();for(const id of event.data.repositoryGroupFilterIds||[])selectedRepositoryGroupIds.add(id);authentication=event.data.authentication||{status:'checking'};if(composingSessionId){renderPending=true;return}renderSessions()}});
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
