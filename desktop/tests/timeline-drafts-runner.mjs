import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.env.TIMELINE_DRAFTS_DIR;
const profile = join(directory,'profile'); mkdirSync(profile,{recursive:true});
app.setPath('userData',profile);
app.disableHardwareAcceleration();
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
  const win = new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
  const js = code=>win.webContents.executeJavaScript(code);
  async function until(code,label) {
    for(let i=0;i<100;i++){if(await js(code)) return;await wait(30);}
    throw new Error(label);
  }
  async function expect(code,label) {if(!await js(code)) throw new Error(label);}
  async function select(id) {
    await js(`window.__draftHarness.select(${JSON.stringify(id)})`);
    await until(`document.querySelector('textarea')?.placeholder===${JSON.stringify(`给 ${id === 'bot-a' ? 'A' : 'B'} 发消息`)}`,'bot did not switch');
  }
  async function type(text) {
    await js(`(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`document.querySelector('textarea').value===${JSON.stringify(text)}`,'typing did not update draft');
  }
  async function send(count) {
    await js(`document.querySelector('button.send').click()`);
    await until(`window.__draftHarness.requests.length===${count}`,'send did not start');
  }
  async function finish(success) {
    await js(`window.__draftHarness.finish(${success})`);
    await until(`!document.querySelector('button.attach').disabled`,'send did not settle');
  }
  const saved = `JSON.parse(localStorage.getItem('pi-bot.message-drafts.v1'))`;
  try {
    await win.loadFile(join(directory,'timeline.html'));
    await until(`document.querySelector('textarea')?.value==='  send A once  '`,'initial draft missing');
    await expect(`!document.querySelector('button[aria-label="上传文档"]') && !document.querySelector('[role="menu"]')`,'standalone document control is still visible');
    await js(`document.querySelector('button[aria-label="添加附件"]').click()`);
    await until(`document.querySelectorAll('[role="menuitem"]').length===1 && !document.querySelectorAll('[role="menuitem"]')[0].disabled`,'attachment menu did not expose the file choice');
    await js(`document.querySelectorAll('[role="menuitem"]')[0].click()`);
    await until(`window.__draftHarness.pickers.length===1 && !document.querySelector('[role="menu"]')`,'file choice did not close menu and open picker');
    await expect(`window.__draftHarness.pickers[0]===''`,'file choice restricted the picker');
    await js(`document.querySelector('button[aria-label="添加附件"]').click()`);
    await until(`!!document.querySelector('[role="menu"]')`,'attachment menu did not reopen');
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await until(`!document.querySelector('[role="menu"]') && document.activeElement===document.querySelector('button[aria-label="添加附件"]')`,'Escape did not close menu and restore focus');
    await js(`document.querySelector('button[aria-label="添加附件"]').click()`);
    await until(`!!document.querySelector('[role="menu"]')`,'attachment menu did not reopen');
    await js(`(()=>{const input=document.querySelector('textarea');input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));input.focus();})()`);
    await until(`!document.querySelector('[role="menu"]')`,'attachment menu remained open after clicking the input');
    await send(1);
    await expect(`window.__draftHarness.requests[0].text==='send A once'`,'send text was not trimmed');
    await select('bot-b');await type('B remains unsent');
    await finish(true);await js(`window.__draftHarness.save()`);
    await expect(`!${saved}['bot-a']`,'sent A draft survived switching to B');
    await expect(`${saved}['bot-b'].text==='B remains unsent' && ${saved}['bot-b'].images[0].name==='B.png'`,'A completion changed B draft');
    await win.reload();
    await until(`document.querySelector('textarea')?.value===''`,'sent A text returned after reload');
    await expect(`document.querySelectorAll('.image-drafts img').length===0`,'sent A images returned after reload');
    await select('bot-b');
    await expect(`document.querySelector('textarea').value==='B remains unsent' && document.querySelectorAll('.image-drafts img').length===1`,'unsent B draft was lost on reload');

    await select('bot-a');await type('send A again');await send(1);
    await type('new A text while sending');await select('bot-b');await finish(true);
    await js(`window.__draftHarness.save()`);
    await expect(`${saved}['bot-a'].text==='new A text while sending'`,'A completion deleted newly typed text');
    await expect(`${saved}['bot-b'].text==='B remains unsent'`,'A completion deleted B text');

    await send(2);await select('bot-a');await finish(false);
    await js(`window.__draftHarness.save()`);
    await expect(`${saved}['bot-b'].text==='B remains unsent' && ${saved}['bot-b'].images.length===1`,'failed B send lost its draft');
    await select('bot-b');
    await expect(`document.querySelector('textarea').value==='B remains unsent'`,'failed send draft missing after switching back');
    await js(`window.__draftHarness.online(false)`);
    await until(`document.querySelector('button.send').disabled`,'offline send not disabled');
    await expect(`!document.querySelector('textarea').disabled`,'offline composer stopped accepting text');
    await type('离线草稿');
    await js(`window.__draftHarness.online(true)`);
    await until(`!document.querySelector('button.send').disabled`,'reconnect did not restore send');
    for(let i=0;i<4;i++){
      await js(`(()=>{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(input.value.length,input.value.length);void window.__draftHarness.confirm('保留输入焦点');})()`);
      await until(`!!document.querySelector('dialog[open]')`,'async dialog missing');
      await js(`document.querySelector('dialog .primary').click()`);
      await until(`document.activeElement===document.querySelector('textarea')`,'dialog did not restore input focus');
      win.webContents.sendInputEvent({type:'char',keyCode:'Z'});
      await until(`document.querySelector('textarea').value.endsWith(${JSON.stringify('Z'.repeat(i+1))})`,'native key input failed after dialog');
    }
    await js(`(()=>{const input=document.querySelector('textarea');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,keyCode:229,bubbles:true}));})()`);
    await expect(`window.__draftHarness.requests.length===2`,'IME confirmation submitted a message');
    await js(`document.querySelector('button[aria-label="添加附件"]').click()`);
    await until(`document.querySelectorAll('[role="menuitem"]').length===1`,'document menu missing');
    await js(`document.querySelectorAll('[role="menuitem"]')[0].click()`);
    await until(`window.__draftHarness.pickers.at(-1)==='' && !document.querySelector('[role="menu"]')`,'document choice did not open its picker and close menu');
    await js(`(()=>{const data=new DataTransfer();data.items.add(new File(['%PDF-1.4\\n'+'x'.repeat(339991)],'测试.csv',{type:'text/csv'}));const picker=document.querySelector('input[type="file"]:not([accept])');picker.files=data.files;picker.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`document.querySelector('.document-drafts')?.textContent.includes('测试.csv') && !document.querySelector('.document-drafts').textContent.includes('取消上传')`,'document upload did not finish');
    await expect(`window.__draftHarness.chunks.length===2 && atob(window.__draftHarness.chunks[0]).length===262144`,'upload did not use bounded chunks');
    await send(3);
    await expect(`window.__draftHarness.requests[2].document_ids[0]==='11223344-1122-4122-8122-112233445566'`,'send omitted uploaded reference');
    await finish(true);
    await expect(`!document.querySelector('.document-drafts').textContent.includes('测试.csv')`,'sent document draft survived');
    await js(`(()=>{const source=window.__draftHarness.sourceImage;const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(source.data),x=>x.charCodeAt(0))],'drop.png',{type:'image/png'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));})()`);
    await until(`document.querySelectorAll('.image-drafts img').length===1`,'dropped image lost visual preview');
    await js(`(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array([0,255,1])],'opaque',{type:'application/octet-stream'}));document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
    await until(`window.__draftHarness.starts.at(-1).name==='opaque' && document.querySelector('.document-drafts').textContent.includes('opaque') && !document.querySelector('.document-drafts').textContent.includes('取消上传')`,'pasted binary did not upload as an ordinary file');
    await expect(`document.querySelectorAll('.image-drafts img').length===1`,'file paste removed the existing image');
    writeFileSync(join(directory,'result.json'),JSON.stringify({ok:true}));
    win.destroy();app.exit(0);
  } catch(error) {
    writeFileSync(join(directory,'result.json'),JSON.stringify({ok:false,error:String(error.stack ?? error)}));
    win.destroy();app.exit(1);
  }
});
