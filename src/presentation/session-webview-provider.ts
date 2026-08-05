import * as vscode from "vscode";
import { SessionManager } from "../application/session-manager";
import { ManagedSession, SessionStatus } from "../domain/session";

type SessionViewModel = Pick<ManagedSession, "id" | "title" | "cwd" | "status" | "currentActivity" | "pendingInteraction">;

interface WebviewMessage {
  type?: unknown;
  sessionId?: unknown;
  text?: unknown;
  decision?: unknown;
  questionId?: unknown;
  answer?: unknown;
}

const groups: Array<{ label: string; statuses: SessionStatus[] }> = [
  { label: "要対応", statuses: ["waiting_for_approval", "waiting_for_input"] },
  { label: "失敗・切断", statuses: ["failed", "disconnected"] },
  { label: "待機中", statuses: ["ready"] },
  { label: "実行中", statuses: ["starting", "running"] },
  { label: "完了", statuses: ["completed"] },
  { label: "中断", statuses: ["interrupted"] },
];

export class SessionWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly subscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly openSession: (sessionId: string) => void,
    private readonly showError: (error: unknown) => void,
  ) {
    this.subscription = manager.onDidChange(() => this.refresh());
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(message));
    view.onDidDispose(() => { this.view = undefined; });
  }

  public refresh(): void {
    void this.view?.webview.postMessage({ type: "sessions", groups: this.snapshot() });
  }

  public dispose(): void {
    this.subscription.dispose();
  }

  private snapshot(): Array<{ label: string; sessions: SessionViewModel[] }> {
    const sessions = this.manager.list();
    return groups.flatMap((group) => {
      const matching = sessions.filter((session) => group.statuses.includes(session.status));
      return matching.length ? [{
        label: group.label,
        sessions: matching.map(({ id, title, cwd, status, currentActivity, pendingInteraction }) => ({
          id, title, cwd, status, currentActivity, pendingInteraction,
        })),
      }] : [];
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (message.type === "ready") {
      this.refresh();
      return;
    }
    if (!sessionId) return;
    try {
      if (message.type === "send" && typeof message.text === "string" && message.text.trim()) {
        await this.manager.sendMessage(sessionId, message.text.trim());
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
    .empty{color:var(--vscode-descriptionForeground);padding:16px 4px}.group{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;margin-top:12px}.group-title{grid-column:1/-1;display:flex;align-items:center;gap:6px;margin:0;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--vscode-sideBarSectionHeader-foreground)}
    .count{padding:1px 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.session{min-width:0;border:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));border-radius:4px;padding:8px;background:var(--vscode-sideBar-background)}
    .session-head{display:flex;align-items:flex-start;gap:6px}.session-main{min-width:0;flex:1}.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta,.activity{margin-top:3px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status{font-size:10px;padding:1px 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
    .icon-button{flex:none;border:0;padding:2px 5px;background:transparent;color:var(--vscode-foreground);cursor:pointer}.icon-button:hover{background:var(--vscode-toolbar-hoverBackground)}form{display:flex;gap:5px;margin-top:8px}textarea{min-width:0;flex:1;resize:vertical;min-height:30px;max-height:100px;padding:5px 6px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    .actions button{border:0;padding:4px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}.actions button:hover{background:var(--vscode-button-hoverBackground)}.actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}.actions button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
    @media (min-width:520px){.group{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (min-width:820px){.group{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (min-width:1100px){.group{grid-template-columns:repeat(4,minmax(0,1fr))}}
  </style>
</head>
<body><main id="sessions" aria-live="polite"></main>
<script nonce="${nonce}">
  const vscode=acquireVsCodeApi();const root=document.getElementById('sessions');let groups=[];
  const labels={ready:'待機中',starting:'開始中',running:'実行中',waiting_for_approval:'承認待ち',waiting_for_input:'入力待ち',completed:'完了',failed:'失敗',interrupted:'中断',disconnected:'切断'};
  function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
  function button(label,title,action,secondary=false){const node=el('button',secondary?'secondary':'',label);node.type='button';node.title=title;node.setAttribute('aria-label',title);node.addEventListener('click',action);return node}
  function render(){const drafts=new Map([...document.querySelectorAll('textarea[data-session]')].map(x=>[x.dataset.session,x.value]));const active=document.activeElement?.dataset?.session;root.replaceChildren();if(!groups.length){root.append(el('p','empty','セッションはまだありません。'));return}
    for(const group of groups){const section=el('section','group');const heading=el('h2','group-title',group.label);heading.append(el('span','count',String(group.sessions.length)));section.append(heading);
      for(const session of group.sessions){const card=el('article','session');const head=el('div','session-head');const main=el('div','session-main');main.append(el('div','title',session.title));main.append(el('div','meta',session.cwd.split(/[\\/]/).pop()+' · '+labels[session.status]));if(session.currentActivity)main.append(el('div','activity',session.currentActivity));head.append(main,el('span','status',labels[session.status]));if(['ready','completed','failed','interrupted','disconnected'].includes(session.status)){const remove=button('×','一覧から削除',()=>vscode.postMessage({type:'remove',sessionId:session.id}));remove.className='icon-button';head.append(remove)}const open=button('↗','詳細を開く',()=>vscode.postMessage({type:'open',sessionId:session.id}));open.className='icon-button';head.append(open);card.append(head);
        const form=el('form');const input=el('textarea');input.dataset.session=session.id;input.rows=1;input.placeholder='このセッションへ指示...';input.title='Ctrl+Enter（MacはCommand+Enter）で送信';input.setAttribute('aria-label',session.title+'への指示');input.value=drafts.get(session.id)||'';form.append(input);form.addEventListener('submit',event=>{event.preventDefault();const text=input.value.trim();if(!text)return;vscode.postMessage({type:'send',sessionId:session.id,text});input.value=''});input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();form.requestSubmit()}});card.append(form);
        const actions=el('div','actions');const pending=session.pendingInteraction;if(pending?.kind==='approval'){actions.append(button('今回のみ許可','今回のみ許可',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'accept'})));if(pending.allowForSession)actions.append(button('セッションで許可','このセッションで許可',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'acceptForSession'})));actions.append(button('拒否','拒否',()=>vscode.postMessage({type:'approval',sessionId:session.id,decision:'decline'}),true))}
        if(pending?.kind==='input')for(const question of pending.questions)for(const option of question.options||[])actions.append(button(option.label,option.description||option.label,()=>vscode.postMessage({type:'answer',sessionId:session.id,questionId:question.id,answer:option.label})));
        if(['starting','running','waiting_for_input'].includes(session.status))actions.append(button('中断','処理を中断',()=>vscode.postMessage({type:'interrupt',sessionId:session.id}),true));if(actions.childElementCount)card.append(actions);section.append(card)}root.append(section)}
    if(active){const input=root.querySelector('textarea[data-session="'+CSS.escape(active)+'"]');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length)}}}
  window.addEventListener('message',event=>{if(event.data?.type==='sessions'){groups=event.data.groups;render()}});
  vscode.postMessage({type:'ready'});
</script></body></html>`;
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
