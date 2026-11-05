// Ponto de entrada do serviço coletor (contêiner próprio no Docker Compose).
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.js';
import { Coletor } from './coletor.js';

const db = await createDatabase({ local: false });
const coletor = new Coletor(db, {
  fonte: process.env.COLETOR_FONTE || 'auto',
  intervaloS: Number(process.env.COLETOR_INTERVALO_S) || 120,
  arquivoReplay: fileURLToPath(new URL('../replay/chuva-jundiai.json', import.meta.url)),
});
await coletor.iniciar();
console.log(`Alagora coletor (${coletor.nome}): fonte=${coletor.fonte}, intervalo=${coletor.intervaloS}s`);

async function parar() {
  coletor.parar();
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', parar);
process.on('SIGINT', parar);
