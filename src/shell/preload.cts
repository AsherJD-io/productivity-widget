/**
 * Preload bridge.
 *
 * The renderer gets a narrow, explicit surface and nothing else: no Node, no
 * filesystem, no ipcRenderer. Every privileged action is a named call.
 */
const { contextBridge, ipcRenderer } = require("electron");

type StateCallback = (payload: unknown) => void;

contextBridge.exposeInMainWorld("widget", {
  onState: (callback: StateCallback): void => {
    ipcRenderer.on("widget:state", (_event: unknown, payload: unknown) => callback(payload));
  },
  toggleTask: (taskId: string): Promise<unknown> => ipcRenderer.invoke("widget:toggle-task", taskId),
  toggleExpand: (): Promise<unknown> => ipcRenderer.invoke("widget:toggle-expand"),
  move: (dx: number, dy: number): Promise<unknown> => ipcRenderer.invoke("widget:move", dx, dy),
  refresh: (): Promise<unknown> => ipcRenderer.invoke("widget:refresh"),
  revealNote: (): Promise<unknown> => ipcRenderer.invoke("widget:reveal-note"),
  diagnostics: (): Promise<unknown> => ipcRenderer.invoke("widget:diagnostics"),
});
