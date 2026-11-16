/** Async HTML dialogs avoid the Windows focus loss caused by Chromium's sync dialogs. */
let tail: Promise<unknown> = Promise.resolve();
function ask(message: string, confirm: boolean): Promise<boolean> {
  const task = tail.then(
    () =>
      new Promise<boolean>((resolve) => {
        const previous = document.activeElement as HTMLElement | null;
        const input =
          previous instanceof HTMLTextAreaElement ||
          previous instanceof HTMLInputElement
            ? previous
            : null;
        const selection = input
          ? [input.selectionStart, input.selectionEnd]
          : null;
        const dialog = document.createElement("dialog");
        dialog.className = "app-dialog";
        dialog.setAttribute("aria-label", confirm ? "确认操作" : "提示");
        const text = document.createElement("p");
        text.textContent = message;
        const row = document.createElement("div");
        row.className = "row-end";
        const finish = (answer: boolean) => {
          dialog.returnValue = answer ? "yes" : "no";
          dialog.close();
        };
        if (confirm) {
          const cancel = document.createElement("button");
          cancel.textContent = "取消";
          cancel.onclick = () => finish(false);
          row.append(cancel);
        }
        const accept = document.createElement("button");
        accept.className = "primary";
        accept.textContent = confirm ? "确认" : "知道了";
        accept.onclick = () => finish(true);
        row.append(accept);
        dialog.append(text, row);
        document.body.append(dialog);
        dialog.addEventListener(
          "close",
          () => {
            const answer = dialog.returnValue === "yes";
            dialog.remove();
            if (previous?.isConnected) {
              previous.focus({ preventScroll: true });
              if (input && selection)
                try {
                  input.setSelectionRange(selection[0], selection[1]);
                } catch {
                  /* Non-text input. */
                }
            }
            resolve(answer);
          },
          { once: true },
        );
        dialog.showModal();
        (confirm ? (row.firstElementChild as HTMLElement) : accept).focus();
      }),
  );
  tail = task.catch(() => {});
  return task;
}
export const confirmAction = (message: string) => ask(message, true);
export const showNotice = (message: string) => {
  void ask(message, false);
};
