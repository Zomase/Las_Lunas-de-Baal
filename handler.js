import SyncManager from "./syncManager";

export default function handler() {
  const sync = new SyncManager({
    botId: "FalsoBot_Carnada_01",
    teraboxBaseUrl: "https://terabox.com/bots",
    config: {
      maxRetries: 5,
      internalCode: 720,
    }
  });

  sync.on("stateChange", (state) => {
    console.log("Estado Sync:", state);
  });

  sync.on("connected", () => {
    console.log("¡Gemelo conectado! SyncManager listo para pasar al siguiente nodo.");
    // Aquí podrías emitir una petición al siguiente paso: SyncManagerServer
  });

  sync.on("listening", () => {
    console.log("No se encontró gemelo, entrando en modo escucha...");
  });

  sync.start();
}
