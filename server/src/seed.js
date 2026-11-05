import { randomUUID } from 'node:crypto';
import { hashPassword, digest } from './auth.js';
export async function seedDemo(db) {
  // Advisory lock impede que duas réplicas criem as mesmas contas simultaneamente.
  const hashes = await Promise.all([hashPassword('Demo@12345'), hashPassword('Admin@12345')]);
  await db.transaction(async q => {
    await q('SELECT pg_advisory_xact_lock(4162601)');
    await q("INSERT INTO users(id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'citizen') ON CONFLICT(email) DO NOTHING", ['10000000-0000-4000-8000-000000000001', 'Ana · demonstração', 'demo@alagora.local', hashes[0]]);
    await q("INSERT INTO users(id,name,email,password_hash,role) VALUES ($1,$2,$3,$4,'admin') ON CONFLICT(email) DO NOTHING", ['10000000-0000-4000-8000-000000000002', 'Gestão · demonstração', 'admin@alagora.local', hashes[1]]);
    const samples = [
      ['20000000-0000-4000-8000-000000000001','Água acumulada na via','Ponto fictício para demonstração. Água sobre parte da pista após chuva forte.','Av. Nove de Julho · Anhangabaú, Jundiaí',-23.1951,-46.8895,'high','active',35],
      ['20000000-0000-4000-8000-000000000002','Bueiro com escoamento lento','Ponto fictício para demonstração. Acúmulo próximo ao cruzamento.','Rua do Retiro · Vila Virgínia, Jundiaí',-23.1917,-46.9021,'moderate','monitoring',90],
      ['20000000-0000-4000-8000-000000000003','Acúmulo próximo à praça','Ponto fictício para demonstração. Água restrita à sarjeta.','Centro · Jundiaí',-23.1857,-46.8844,'low','active',150],
      ['20000000-0000-4000-8000-000000000004','Via com escoamento restabelecido','Ponto fictício para demonstração. A situação foi encerrada após escoamento.','Vila Arens · Jundiaí',-23.2052,-46.8762,'moderate','resolved',230]
    ];
    for (const [id,title,description,address,lat,lng,severity,status,minutes] of samples) {
      const result = await q(`INSERT INTO reports(id,author_id,title,description,address,latitude,longitude,severity,status,payload_hash,is_demo,created_at,updated_at)
        VALUES ($1,'10000000-0000-4000-8000-000000000001',$2,$3,$4,$5,$6,$7,$8,$9,true,now()-($10::int * interval '1 minute'),now()-($10::int * interval '1 minute')) ON CONFLICT(id) DO NOTHING RETURNING id`,[id,title,description,address,lat,lng,severity,status,digest(id),minutes]);
      if (result.rows.length) await q('INSERT INTO report_history(id,report_id,user_id,to_status,note,version) VALUES ($1,$2,$3,$4,$5,1)',[randomUUID(),id,'10000000-0000-4000-8000-000000000001',status,'Registro fictício de demonstração.']);
    }
  });
}
