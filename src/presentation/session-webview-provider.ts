import * as vscode from "vscode";
import { AuthenticationManager } from "../application/authentication-manager";
import { SessionManager } from "../application/session-manager";
import { ManagedSession } from "../domain/session";

type SessionViewModel = Pick<ManagedSession, "id" | "title" | "status" | "currentActivity" | "finalResult" | "autoApprove" | "pendingInteraction">;

interface WebviewMessage {
  type?: unknown;
  sessionId?: unknown;
  text?: unknown;
  decision?: unknown;
  questionId?: unknown;
  answer?: unknown;
  sessionIds?: unknown;
  enabled?: unknown;
}

export class SessionWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly subscription: { dispose(): void };
  private readonly authSubscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly authentication: AuthenticationManager,
    private readonly openSession: (sessionId: string) => void,
    private readonly showError: (error: unknown) => void,
  ) {
    this.subscription = manager.onDidChange(() => this.refresh());
    this.authSubscription = authentication.onDidChange(() => this.refresh());
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
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

  public refresh(): void {
    void this.view?.webview.postMessage({
      type: "sessions",
      sessions: this.snapshot(),
      authentication: this.authentication.getState(),
    });
  }

  public dispose(): void {
    this.subscription.dispose();
    this.authSubscription.dispose();
  }

  private snapshot(): SessionViewModel[] {
    return this.manager.list().map(({ id, title, status, currentActivity, finalResult, autoApprove, pendingInteraction }) => ({
      id, title, status, currentActivity, finalResult, autoApprove, pendingInteraction,
    }));
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (message.type === "ready") {
      this.refresh();
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
      } else if (message.type === "answer" && typeof message.questionId === "string" && typeof message.answer === "string") {
        this.manager.resolveInput(sessionId, { [message.questionId]: [message.answer] });
      }
    } catch (error) {
      this.showError(error);
    }
  }
}

function isDecision(value: unknown): value is "accept" | "acceptForSession" | "decline" {
  return value === "accept" || value === "acceptForSession" || value === "decline";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
    .auth{margin:10px 0;padding:10px;border:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));border-radius:4px}.auth.error{border-color:var(--vscode-inputValidation-errorBorder)}.auth-title{font-weight:600}.auth-detail{margin:5px 0;color:var(--vscode-descriptionForeground);word-break:break-word}.auth-code{display:block;margin:8px 0;padding:7px;text-align:center;font:600 16px var(--vscode-editor-font-family);letter-spacing:2px;background:var(--vscode-textCodeBlock-background);user-select:all}
    .empty{color:var(--vscode-descriptionForeground);padding:16px 4px}.sessions-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;margin-top:12px}.session{min-width:0;border:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));border-left:3px solid var(--vscode-descriptionForeground);border-radius:4px;padding:8px;background:var(--vscode-sideBar-background)}
    .session-head{display:flex;align-items:flex-start;gap:6px}.session-main{min-width:0;flex:1}.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.activity{margin-top:3px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status{font-size:10px;padding:1px 5px;border:1px solid currentColor;border-radius:8px;color:var(--vscode-descriptionForeground)}.result-popover{position:relative;display:inline-block}.result{display:none;position:absolute;z-index:10;top:calc(100% + 7px);left:0;width:min(320px,calc(100vw - 32px));padding:8px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-textCodeBlock-background));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));box-shadow:0 2px 8px var(--vscode-widget-shadow);white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}.result::before{content:'';position:absolute;left:12px;bottom:100%;border:6px solid transparent;border-bottom-color:var(--vscode-widget-border,var(--vscode-panel-border))}.result::after{content:'';position:absolute;right:0;bottom:100%;left:0;height:8px}.result-popover.is-open .result,.result-toggle:focus + .result{display:block}.result-toggle{margin-top:7px;border:0;padding:3px 6px;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer}.result-toggle:hover,.result-toggle:focus{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.result-label{display:block;margin-bottom:4px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:600}
    .session[data-status="ready"],.session[data-status="completed"]{border-left-color:var(--vscode-testing-iconPassed,var(--vscode-charts-green))}.session[data-status="starting"],.session[data-status="running"]{border-left-color:var(--vscode-progressBar-background,var(--vscode-charts-blue))}.session[data-status="waiting_for_approval"],.session[data-status="waiting_for_input"],.session[data-status="interrupted"]{border-left-color:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow))}.session[data-status="failed"],.session[data-status="disconnected"]{border-left-color:var(--vscode-errorForeground,var(--vscode-charts-red))}
    .session[data-status="ready"] .status,.session[data-status="completed"] .status{color:var(--vscode-testing-iconPassed,var(--vscode-charts-green))}.session[data-status="starting"] .status,.session[data-status="running"] .status{color:var(--vscode-progressBar-background,var(--vscode-charts-blue))}.session[data-status="waiting_for_approval"] .status,.session[data-status="waiting_for_input"] .status,.session[data-status="interrupted"] .status{color:var(--vscode-inputValidation-warningForeground,var(--vscode-charts-yellow))}.session[data-status="failed"] .status,.session[data-status="disconnected"] .status{color:var(--vscode-errorForeground,var(--vscode-charts-red))}
    .drag-handle,.icon-button{flex:none;border:0;padding:2px 5px;background:transparent;color:var(--vscode-foreground)}.drag-handle{cursor:grab;user-select:none}.drag-handle:active{cursor:grabbing}.drag-handle:hover,.drag-handle:focus,.icon-button:hover{outline:none;background:var(--vscode-toolbar-hoverBackground)}.session.dragging{opacity:.55}form{display:flex;gap:5px;margin-top:8px}textarea{min-width:0;flex:1;resize:vertical;min-height:30px;max-height:100px;padding:5px 6px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    .actions button,.header-action{border:0;padding:4px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}.actions button:hover,.header-action:hover{background:var(--vscode-button-hoverBackground)}.actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.actions button.secondary,.header-action.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.auto-control{display:flex;align-items:center;gap:3px;font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}.auto-control input{margin:0}.auto-control:has(input:checked){color:var(--vscode-inputValidation-warningForeground,var(--vscode-charts-yellow));font-weight:600}
    @media (min-width:520px){.sessions-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (min-width:820px){.sessions-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (min-width:1100px){.sessions-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
  </style>
</head>
<body><main id="sessions" aria-live="polite"></main>
<script nonce="${nonce}">
  const vscode=acquireVsCodeApi();const root=document.getElementById('sessions');let sessions=[];let authentication={status:'checking'};let draggedSessionId;let composingSessionId;let renderPending=false;
  const labels={ready:'待機中',starting:'開始中',running:'実行中',waiting_for_approval:'承認待ち',waiting_for_input:'入力待ち',completed:'完了',failed:'失敗',interrupted:'中断',disconnected:'切断'};
  function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
  function button(label,title,action,secondary=false){const node=el('button',secondary?'secondary':'',label);node.type='button';node.title=title;node.setAttribute('aria-label',title);node.addEventListener('click',action);return node}
  function renderAuthentication(){const auth=el('section','auth'+(authentication.status==='error'?' error':''));const title=el('div','auth-title');const detail=el('p','auth-detail');const actions=el('div','actions');if(authentication.status==='checking'){title.textContent='認証状態を確認中';detail.textContent='Codexアカウントを確認しています。'}else if(authentication.status==='authenticated'){title.textContent='Codexにログイン済み';detail.textContent=[authentication.email,authentication.planType].filter(Boolean).join(' · ')||authentication.authMode||'利用可能';actions.append(button('ログアウト','Codexからログアウト',()=>vscode.postMessage({type:'logout'}),true))}else if(authentication.status==='logging_in'){title.textContent='ログインを待っています';detail.textContent=authentication.userCode?'表示されたコードをブラウザで入力してください。':'ブラウザで認証を完了してください。';if(authentication.userCode)auth.append(title,detail,el('code','auth-code',authentication.userCode));else auth.append(title,detail);actions.append(button('キャンセル','ログインをキャンセル',()=>vscode.postMessage({type:'cancelLogin'}),true));auth.append(actions);return auth}else{title.textContent=authentication.status==='error'?'ログインできませんでした':'Codexへのログインが必要です';detail.textContent=authentication.error||'ChatGPTアカウントでログインしてください。';actions.append(button('ブラウザでログイン','ChatGPTでログイン',()=>vscode.postMessage({type:'loginBrowser'})));actions.append(button('デバイスコード','デバイスコードでログイン',()=>vscode.postMessage({type:'loginDeviceCode'}),true))}auth.append(title,detail);if(actions.childElementCount)auth.append(actions);return auth}
  function publishOrder(grid){vscode.postMessage({type:'reorder',sessionIds:[...grid.querySelectorAll('.session')].map(card=>card.dataset.sessionId)})}
  function render(){const drafts=new Map([...document.querySelectorAll('textarea[data-session]')].map(x=>[x.dataset.session,x.value]));const active=document.activeElement?.dataset?.session;root.replaceChildren();root.append(renderAuthentication());if(authentication.status!=='authenticated')return;if(!sessions.length){root.append(el('p','empty','セッションはまだありません。'));return}const grid=el('div','sessions-grid');
      for(const session of sessions){const card=el('article','session');card.dataset.status=session.status;card.dataset.sessionId=session.id;const head=el('div','session-head');const handle=el('span','drag-handle','⠿');handle.draggable=true;handle.tabIndex=0;handle.title='ドラッグまたは矢印キーで並べ替え';handle.setAttribute('role','button');handle.setAttribute('aria-label',session.title+'を並べ替え');handle.addEventListener('dragstart',event=>{draggedSessionId=session.id;card.classList.add('dragging');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',session.id)});handle.addEventListener('dragend',()=>{draggedSessionId=undefined;card.classList.remove('dragging')});handle.addEventListener('keydown',event=>{const backward=event.key==='ArrowUp'||event.key==='ArrowLeft';const forward=event.key==='ArrowDown'||event.key==='ArrowRight';if(!backward&&!forward)return;event.preventDefault();const sibling=backward?card.previousElementSibling:card.nextElementSibling;if(!sibling)return;if(backward)sibling.before(card);else sibling.after(card);publishOrder(grid);handle.focus()});const main=el('div','session-main');main.append(el('div','title',session.title));if(session.currentActivity)main.append(el('div','activity',session.currentActivity));head.append(handle,main,el('span','status',labels[session.status]));if(['starting','running','waiting_for_input'].includes(session.status)){const interrupt=button('中断','処理を中断',()=>vscode.postMessage({type:'interrupt',sessionId:session.id}),true);interrupt.classList.add('header-action');head.append(interrupt)}if(['ready','completed','failed','interrupted','disconnected'].includes(session.status)){const remove=button('×','一覧から削除',()=>vscode.postMessage({type:'remove',sessionId:session.id}));remove.className='icon-button';head.append(remove)}const open=button('↗','詳細を開く',()=>vscode.postMessage({type:'open',sessionId:session.id}));open.className='icon-button';head.append(open);card.append(head);
        const form=el('form');const input=el('textarea');input.dataset.session=session.id;input.rows=1;input.placeholder='このセッションへ指示...';input.title='Enterで送信、Ctrl+Enter（MacはCommand+Enter）で改行';input.setAttribute('aria-label',session.title+'への指示');input.value=drafts.get(session.id)||'';form.append(input);form.addEventListener('submit',event=>{event.preventDefault();const text=input.value.trim();if(!text)return;vscode.postMessage({type:'send',sessionId:session.id,text});input.value=''});input.addEventListener('compositionstart',()=>{composingSessionId=session.id});input.addEventListener('compositionend',()=>{composingSessionId=undefined;if(renderPending){renderPending=false;queueMicrotask(renderSessions)}});input.addEventListener('keydown',event=>{if(event.key!=='Enter'||event.isComposing||event.keyCode===229||composingSessionId===session.id)return;event.preventDefault();if(event.ctrlKey||event.metaKey){input.setRangeText('\\n',input.selectionStart,input.selectionEnd,'end');return}form.requestSubmit()});card.append(form);
        const actions=el('div','actions');const pending=session.pendingInteraction;if(pending?.kind==='approval'){actions.append(button('今回のみ許可','今回のみ許可',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'accept'})));if(pending.allowForSession)actions.append(button('セッションで許可','このセッションで許可',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'acceptForSession'})));actions.append(button('拒否','拒否',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'decline'}),true))}
        if(pending?.kind==='input')for(const question of pending.questions)for(const option of question.options||[])actions.append(button(option.label,option.description||option.label,()=>vscode.postMessage({type:'answer',sessionId:session.id,questionId:question.id,answer:option.label})));
        if(actions.childElementCount)card.append(actions);grid.append(card)}grid.addEventListener('dragover',event=>{if(!draggedSessionId)return;const target=event.target.closest('.session');const dragged=grid.querySelector('[data-session-id="'+CSS.escape(draggedSessionId)+'"]');if(!target||!dragged||target===dragged)return;event.preventDefault();const rect=target.getBoundingClientRect();const after=event.clientY>rect.top+rect.height/2;target[after?'after':'before'](dragged)});grid.addEventListener('drop',event=>{if(!draggedSessionId)return;event.preventDefault();publishOrder(grid)});root.append(grid)
    if(active){const input=root.querySelector('textarea[data-session="'+CSS.escape(active)+'"]');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length)}}}
  function decorateResults(){for(const session of sessions){const card=root.querySelector('[data-session-id="'+CSS.escape(session.id)+'"]');if(!card||!session.finalResult)continue;const resultId='result-'+session.id.replace(/[^a-zA-Z0-9_-]/g,'-');const popover=el('div','result-popover');const toggle=el('button','result-toggle','最終結果');toggle.type='button';toggle.setAttribute('aria-label','最終結果を表示');toggle.setAttribute('aria-describedby',resultId);const result=el('div','result');result.id=resultId;result.setAttribute('role','tooltip');result.append(el('span','result-label','最終結果'),document.createTextNode(session.finalResult));let closeTimer;popover.addEventListener('mouseenter',()=>{clearTimeout(closeTimer);popover.classList.add('is-open')});popover.addEventListener('mouseleave',()=>{clearTimeout(closeTimer);closeTimer=setTimeout(()=>popover.classList.remove('is-open'),250)});popover.append(toggle,result);card.insertBefore(popover,card.querySelector('form'))}}
  function decorateAutoControls(){for(const session of sessions){const card=root.querySelector('[data-session-id="'+CSS.escape(session.id)+'"]');const head=card?.querySelector('.session-head');if(!head)continue;const label=el('label','auto-control');label.title='承認要求をこのセッションで自動許可';const input=el('input');input.type='checkbox';input.checked=session.autoApprove;input.setAttribute('aria-label',session.title+'のAuto承認');input.addEventListener('change',()=>vscode.postMessage({type:'autoApprove',sessionId:session.id,enabled:input.checked}));label.append(input,document.createTextNode('Auto'));head.insertBefore(label,head.querySelector('.icon-button'))}}
  function captureFocus(){const active=document.activeElement;const card=active?.closest?.('.session');if(!card)return null;return{sessionId:card.dataset.sessionId,ariaLabel:active===card?null:active.getAttribute('aria-label')}}
  function restoreFocus(state){if(!state)return;const card=root.querySelector('[data-session-id="'+CSS.escape(state.sessionId)+'"]');if(!card)return;const target=state.ariaLabel?card.querySelector('[aria-label="'+CSS.escape(state.ariaLabel)+'"]'):card;(target||card).focus()}
  function renderSessions(){const focus=captureFocus();render();decorateResults();decorateAutoControls();restoreFocus(focus)}
  window.addEventListener('message',event=>{if(event.data?.type==='sessions'){sessions=event.data.sessions;authentication=event.data.authentication||{status:'checking'};if(composingSessionId){renderPending=true;return}renderSessions()}});
  vscode.postMessage({type:'ready'});
</script></body></html>`;
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
