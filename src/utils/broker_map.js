/**
 * Mapa de Corretoras B3
 * Identifica Formadores de Mercado no WDO/DOL
 */
const BROKERS = {
  3:   { nome: 'XP INVESTIMENTOS',     tipo: 'market_maker', peso: 3 },
  7:   { nome: 'ITAU BBA',             tipo: 'market_maker', peso: 3 },
  14:  { nome: 'BRADESCO BBI',         tipo: 'market_maker', peso: 3 },
  16:  { nome: 'BTG PACTUAL',          tipo: 'market_maker', peso: 3 },
  39:  { nome: 'SANTANDER',            tipo: 'market_maker', peso: 3 },
  45:  { nome: 'GOLDMAN SACHS',        tipo: 'market_maker', peso: 3 },
  60:  { nome: 'MORGAN STANLEY',       tipo: 'market_maker', peso: 3 },
  72:  { nome: 'BRADESCO',             tipo: 'market_maker', peso: 3 },
  78:  { nome: 'JP MORGAN',            tipo: 'market_maker', peso: 3 },
  83:  { nome: 'CITIBANK',             tipo: 'market_maker', peso: 3 },
  90:  { nome: 'CREDIT SUISSE',        tipo: 'market_maker', peso: 2 },
  101: { nome: 'MERRILL LYNCH',        tipo: 'market_maker', peso: 2 },
  110: { nome: 'DEUTSCHE BANK',        tipo: 'market_maker', peso: 2 },
  114: { nome: 'UBS',                  tipo: 'market_maker', peso: 2 },
  120: { nome: 'BOFA',                 tipo: 'market_maker', peso: 2 },
  131: { nome: 'GENIAL',               tipo: 'corretora',    peso: 1 },
  179: { nome: 'CLEAR',                tipo: 'corretora',    peso: 1 },
  184: { nome: 'RICO',                 tipo: 'corretora',    peso: 1 },
  208: { nome: 'MODAL MAIS',           tipo: 'corretora',    peso: 1 },
  217: { nome: 'AGORA',                tipo: 'corretora',    peso: 1 },
  239: { nome: 'NOVA FUTURA',          tipo: 'corretora',    peso: 1 },
  248: { nome: 'TERRA',                tipo: 'corretora',    peso: 1 },
  311: { nome: 'TORO',                 tipo: 'corretora',    peso: 1 },
};

function getBroker(codigo)    { return BROKERS[parseInt(codigo)] || { nome: `#${codigo}`, tipo: 'desconhecida', peso: 1 }; }
function isMarketMaker(codigo){ return BROKERS[parseInt(codigo)]?.tipo === 'market_maker'; }
function getBrokerName(codigo){ return BROKERS[parseInt(codigo)]?.nome || `#${codigo}`; }

module.exports = { BROKERS, getBroker, isMarketMaker, getBrokerName };
