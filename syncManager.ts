/**
 * syncManager.ts
 * 
 * Coordinador avanzado para sincronización y despliegue dinámico de bots desde Terabox a Render.
 * Compatible con TypeScript 5.8.3 y @whiskeysockets/baileys v6.7.18.
 */

import { EventEmitter } from "events";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";

type SyncState = "idle" | "searching" | "connected" | "listening" | "deploying" | "error";

interface SyncConfig {
  maxRetries: number;
  retryIntervalMs: number;
  connectionTimeoutMs: number;
  internalCode: number; // Código interno para identificar bots gemelos
  pingUrl: string;      // URL para intentar "contactar" al gemelo
  botsFilesUrls: string[]; // URLs directas para descargar archivos bot desde Terabox
  botsExecCommand: string; // Comando para lanzar el bot descargado
  deployPath: string;       // Ruta donde se escribirán los bots descargados
}

interface SyncManagerOptions {
  botId: string;             // Identificador único del bot, p.ej: "LataUnid_Proyecto-Rob1"
  teraboxBaseUrl: string;    // URL base para llamadas a Terabox (puede usarse para sincronización)
  config?: Partial<SyncConfig>;
}

interface SyncData {
  internalCode: number;
  botId: string;
  [key: string]: any; // Para aceptar otros datos que puedan venir
}

function isSyncData(obj: any): obj is SyncData {
  return obj !== null &&
         typeof obj === "object" &&
         typeof obj.internalCode === "number" &&
         typeof obj.botId === "string";
}

class SyncManager extends EventEmitter {
  private state: SyncState = "idle";
  private retries = 0;
  private config: SyncConfig;
  private options: SyncManagerOptions;
  private isStopped = false;

  constructor(options: SyncManagerOptions) {
    super();

    this.config = {
      maxRetries: 5,
      retryIntervalMs: 7000,
      connectionTimeoutMs: 8000,
      internalCode: 720,
      pingUrl: "",
      botsFilesUrls: [],           // <- Aquí pondrás los links directos Terabox
      botsExecCommand: "node bot.js", // comando para lanzar bot
      deployPath: "./deployedBots",    // carpeta local para desplegar bots
      ...options.config,
    };

    this.options = options;

    if (!this.config.pingUrl) {
      this.config.pingUrl = `${this.options.teraboxBaseUrl}/sync/ping?botId=${this.options.botId}`;
    }
  }

  /**
   * Inicia el proceso de sincronización
   */
  public async start() {
    this.isStopped = false;
    this.state = "searching";
    this.retries = 0;
    this.emit("stateChange", this.state);

    try {
      await this.attemptConnectionLoop();
    } catch (error) {
      this.setError(error);
    }
  }

  public stop() {
    this.isStopped = true;
    this.state = "idle";
    this.emit("stateChange", this.state);
  }

  private async attemptConnectionLoop() {
    while (!this.isStopped && this.retries < this.config.maxRetries) {
      this.emit("attempt", this.retries + 1);

      try {
        const connected = await this.tryConnectToGemelo();

        if (connected) {
          this.state = "connected";
          this.emit("stateChange", this.state);
          this.emit("connected");

          // Espera la señal para desplegar
          await this.waitForDeploySignal();

          return;
        }

        this.retries++;
        this.emit("retrying", this.retries);

        if (this.retries >= this.config.maxRetries) break;

        await this.sleep(this.config.retryIntervalMs);
      } catch (error) {
        this.setError(error);
        this.retries++;

        if (this.retries >= this.config.maxRetries) break;

        await this.sleep(this.config.retryIntervalMs);
      }
    }

    // Si no conecta, cambia a modo escucha
    this.state = "listening";
    this.emit("stateChange", this.state);
    this.emit("listening");

    // También puede despertar al gemelo desde aquí
    // (tú decides si llamas a wakeUpGemelo aquí)
  }

  /**
   * Intenta conectar con el gemelo (SyncManagerServer en Terabox)
   */
  private async tryConnectToGemelo(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.connectionTimeoutMs);

      const response = await fetch(this.config.pingUrl, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) return false;

      const data = await response.json();

      if (isSyncData(data) && data.internalCode === this.config.internalCode && data.botId !== this.options.botId) {
        this.emit("gemeloFound", data.botId);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Método que espera la señal para desplegar bots.
   * Puede ser una ruta /poll o websocket que tu SyncManagerServer llame.
   * Aquí simulamos con poll simple cada X segundos.
   */
  private async waitForDeploySignal() {
    this.emit("waitingDeploySignal");
    this.state = "deploying";
    this.emit("stateChange", this.state);

    const maxPolls = 30; // espera hasta ~3.5 min (30 * 7 seg)
    let polls = 0;

    while (!this.isStopped && polls < maxPolls) {
      try {
        const signalResponse = await fetch(`${this.options.teraboxBaseUrl}/sync/deploySignal`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        if (signalResponse.ok) {
          const body = await signalResponse.json();

          if (body && body.deploy === true) {
            this.emit("deploySignalReceived");
            await this.deployBots();
            return;
          }
        }
      } catch (error) {
        this.emit("error", error);
      }

      polls++;
      await this.sleep(this.config.retryIntervalMs);
    }

    this.emit("deploySignalTimeout");
    this.setError(new Error("Timeout esperando señal de deploy"));
  }

  /**
   * Descarga, escribe y ejecuta los bots desde Terabox
   */
  private async deployBots() {
    try {
      this.emit("deployStart");
      // Crear carpeta de deploy si no existe
      await fs.mkdir(this.config.deployPath, { recursive: true });

      for (const fileUrl of this.config.botsFilesUrls) {
        this.emit("downloadStart", fileUrl);

        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`No se pudo descargar archivo: ${fileUrl}`);

        const filename = path.basename(fileUrl);
        const fullPath = path.resolve(this.config.deployPath, filename);
        const fileData = await res.text();

        await fs.writeFile(fullPath, fileData, "utf-8");
        this.emit("downloadComplete", filename);
      }

      this.emit("deployFilesWritten");

      // Ejecutar bot principal (puedes modificar comando según tu estructura)
      await this.execCommand(this.config.botsExecCommand, { cwd: this.config.deployPath });

      this.emit("deploySuccess");
    } catch (error) {
      this.setError(error);
    }
  }

  /**
   * Ejecuta un comando shell, devuelve Promise
   */
  private execCommand(cmd: string, options?: { cwd?: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emit("execStart", cmd);
      exec(cmd, options ?? {}, (error, stdout, stderr) => {
        if (error) {
          this.emit("execError", error, stderr);
          reject(error);
          return;
        }
        this.emit("execSuccess", stdout);
        resolve();
      });
    });
  }

  /**
   * Método para despertar el gemelo manualmente
   */
  public async wakeUpGemelo() {
    if (this.state !== "listening") return;

    try {
      const wakeUrl = `${this.options.teraboxBaseUrl}/sync/wake?botId=${this.options.botId}`;
      const response = await fetch(wakeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalCode: this.config.internalCode }),
      });

      if (response.ok) {
        this.emit("wokeGemelo");
      }
    } catch (error) {
      this.emit("error", error);
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private setError(error: any) {
    this.state = "error";
    this.emit("stateChange", this.state);
    this.emit("error", error);
  }
}

export default SyncManager;
