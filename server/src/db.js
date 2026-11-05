import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

export const CANAL = 'alagora_eventos';

// Mesmas consultas SQL nos dois modos. Docker usa PostgreSQL; PGlite é apenas
// uma alternativa local/testes e não substitui a arquitetura de apresentação.
//
// Mensagens entre serviços: no PostgreSQL usamos LISTEN/NOTIFY (publicar/assinar).
// Uma notificação emitida dentro de uma transação só é entregue se ela for
// confirmada (COMMIT): quem assina nunca recebe evento de algo que não foi gravado.
// No modo PGlite (um único processo) um EventEmitter faz o mesmo papel.
export async function createDatabase({ local = false, path, log = console } = {}) {
  const engine = local ? new PGlite(path) : new pg.Pool({ max: 10 });
  if (local) await engine.waitReady;
  if (!local) engine.on('error', e => log.error?.(`[db] conexão ociosa falhou: ${e.message}`));
  const emissor = new EventEmitter();
  emissor.setMaxListeners(50);
  let tail = Promise.resolve();
  const exclusive = fn => {
    const result = tail.then(fn, fn);
    tail = result.catch(() => {});
    return result;
  };
  const run = (sql, args = []) => engine.query(sql, args);
  const ouvintes = [];

  const db = {
    local,
    query: (sql, args) => local ? exclusive(() => run(sql, args)) : run(sql, args),
    /**
     * fn recebe q(sql, args); q.notify(evento) agenda uma mensagem no canal,
     * entregue somente após o COMMIT.
     */
    async transaction(fn) {
      const execute = async () => {
        const client = local ? engine : await engine.connect();
        const pendentes = [];
        try {
          await client.query('BEGIN');
          const q = (sql, args = []) => client.query(sql, args);
          q.notify = async evento => {
            if (local) pendentes.push(evento);
            else await client.query('SELECT pg_notify($1, $2)', [CANAL, JSON.stringify(evento)]);
          };
          const result = await fn(q);
          await client.query('COMMIT');
          for (const e of pendentes) setImmediate(() => emissor.emit(CANAL, e));
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { if (!local) client.release(); }
      };
      return local ? exclusive(execute) : execute();
    },
    /** Publica um evento fora de transação. */
    async notify(evento) {
      if (local) { setImmediate(() => emissor.emit(CANAL, evento)); return; }
      await engine.query('SELECT pg_notify($1, $2)', [CANAL, JSON.stringify(evento)]);
    },
    /**
     * Assina o canal. No PostgreSQL usa uma conexão dedicada (LISTEN não funciona
     * pelo pool) e reconecta sozinha com espera crescente se o banco cair.
     * `aoReconectar` é chamado após cada reconexão, para recuperar o que se perdeu.
     */
    listen(handler, { aoReconectar } = {}) {
      if (local) { emissor.on(CANAL, handler); return () => emissor.off(CANAL, handler); }
      const ouvinte = { ativo: true, cliente: null };
      ouvintes.push(ouvinte);
      let espera = 1000;
      let primeira = true;
      const conectar = async () => {
        if (!ouvinte.ativo) return;
        const cliente = new pg.Client();
        ouvinte.cliente = cliente;
        const recomecar = motivo => {
          if (ouvinte.cliente !== cliente || !ouvinte.ativo) return;
          ouvinte.cliente = null;
          log.warn?.(`[db] assinatura do canal caiu (${motivo}); nova tentativa em ${espera} ms`);
          cliente.end().catch(() => {});
          setTimeout(conectar, espera);
          espera = Math.min(espera * 2, 30_000);
        };
        cliente.on('error', e => recomecar(e.message));
        cliente.on('end', () => recomecar('conexão encerrada'));
        cliente.on('notification', msg => {
          if (msg.channel !== CANAL) return;
          try { handler(JSON.parse(msg.payload)); } catch (e) { log.error?.(`[db] evento inválido: ${e.message}`); }
        });
        try {
          await cliente.connect();
          await cliente.query(`LISTEN ${CANAL}`);
          espera = 1000;
          if (!primeira) aoReconectar?.();
          primeira = false;
        } catch (e) { recomecar(e.message); }
      };
      conectar();
      return () => { ouvinte.ativo = false; ouvinte.cliente?.end().catch(() => {}); };
    },
    async close() {
      for (const o of ouvintes) { o.ativo = false; await o.cliente?.end().catch(() => {}); }
      emissor.removeAllListeners();
      await tail;
      return local ? engine.close() : engine.end();
    }
  };

  // Esquema: API e coletor iniciam juntos; o bloqueio consultivo garante que só
  // um processo cria/atualiza as tabelas por vez (exclusão mútua entre processos).
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  if (local) await engine.exec(schema);
  else {
    const client = await engine.connect();
    try {
      await client.query('SELECT pg_advisory_lock(4162600)');
      await client.query(schema);
    } finally {
      await client.query('SELECT pg_advisory_unlock(4162600)').catch(() => {});
      client.release();
    }
  }
  return db;
}
