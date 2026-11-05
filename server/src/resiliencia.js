// Mecanismos de tolerância a falhas usados nas chamadas a serviços externos:
// tempo limite, nova tentativa com espera exponencial e disjuntor (circuit breaker).

export const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Executa fn(signal) e cancela se passar de `ms` milissegundos. */
export async function comTempoLimite(fn, ms) {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(new Error(`tempo limite de ${ms} ms excedido`)), ms);
  try {
    return await fn(controle.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Repete fn até `tentativas` vezes. A espera entre tentativas dobra a cada falha
 * (base, 2·base, 4·base…) com uma variação aleatória para que várias réplicas
 * não tentem ao mesmo tempo. `aoFalhar` recebe (erro, tentativa) para registro.
 */
export async function comNovasTentativas(fn, { tentativas = 3, base = 500, aoFalhar, dormir = esperar } = {}) {
  let ultimo;
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn(i);
    } catch (erro) {
      ultimo = erro;
      aoFalhar?.(erro, i);
      if (i < tentativas) await dormir(base * 2 ** (i - 1) * (0.8 + Math.random() * 0.4));
    }
  }
  throw ultimo;
}

export class CircuitoAberto extends Error {
  constructor(nome, ateMs) {
    super(`Circuito '${nome}' aberto; nova tentativa em ${Math.ceil(ateMs / 1000)} s`);
    this.name = 'CircuitoAberto';
  }
}

/**
 * Disjuntor: depois de `limite` falhas seguidas, recusa chamadas por `pausa` ms
 * (estado ABERTO), poupando o serviço externo e respondendo rápido. Passada a
 * pausa, deixa uma chamada de teste (MEIO_ABERTO): sucesso fecha, falha reabre.
 */
export class Disjuntor {
  constructor(nome, { limite = 3, pausa = 5 * 60_000, agora = () => Date.now() } = {}) {
    Object.assign(this, { nome, limite, pausa, agora });
    this.estado = 'FECHADO';
    this.falhasSeguidas = 0;
    this.abertoAte = 0;
    this.totalFalhas = 0;
    this.totalSucessos = 0;
  }

  async executar(fn) {
    if (this.estado === 'ABERTO') {
      if (this.agora() < this.abertoAte) throw new CircuitoAberto(this.nome, this.abertoAte - this.agora());
      this.estado = 'MEIO_ABERTO';
    }
    try {
      const resultado = await fn();
      this.estado = 'FECHADO';
      this.falhasSeguidas = 0;
      this.totalSucessos++;
      return resultado;
    } catch (erro) {
      this.totalFalhas++;
      this.falhasSeguidas++;
      if (this.estado === 'MEIO_ABERTO' || this.falhasSeguidas >= this.limite) {
        this.estado = 'ABERTO';
        this.abertoAte = this.agora() + this.pausa;
      }
      throw erro;
    }
  }

  resumo() {
    return {
      estado: this.estado,
      falhas_seguidas: this.falhasSeguidas,
      total_falhas: this.totalFalhas,
      total_sucessos: this.totalSucessos,
      aberto_ate: this.estado === 'ABERTO' ? new Date(this.abertoAte).toISOString() : null,
    };
  }
}
