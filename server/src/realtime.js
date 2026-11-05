// Tempo real: os aparelhos mantêm uma conexão HTTP aberta (Server-Sent Events)
// e a API empurra os eventos assim que o banco os publica no canal.
import { randomUUID } from 'node:crypto';

export class CentralEventos {
  constructor({ intervaloPing = 15_000 } = {}) {
    this.clientes = new Set();
    this.enviados = 0;
    this.ultimoEvento = null;
    // Comentário periódico mantém a conexão viva atrás de proxies e detecta clientes mortos.
    this.ping = setInterval(() => this.#escrever(': ping\n\n'), intervaloPing);
    this.ping.unref?.();
  }

  get total() { return this.clientes.size; }

  /** Registra uma resposta HTTP como cliente SSE. */
  conectar(req, res, saudacao) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // `retry` diz ao navegador quanto esperar antes de reconectar sozinho.
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify(saudacao)}\n\n`);
    const cliente = { id: randomUUID(), res };
    this.clientes.add(cliente);
    req.on('close', () => this.clientes.delete(cliente));
  }

  /** Envia um evento nomeado a todos os clientes conectados a esta instância da API. */
  publicar(tipo, dados) {
    this.enviados++;
    this.ultimoEvento = { tipo, em: new Date().toISOString() };
    this.#escrever(`event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`);
  }

  #escrever(texto) {
    for (const c of this.clientes) {
      try { c.res.write(texto); } catch { this.clientes.delete(c); }
    }
  }

  fechar() {
    clearInterval(this.ping);
    for (const c of this.clientes) c.res.end();
    this.clientes.clear();
  }
}
