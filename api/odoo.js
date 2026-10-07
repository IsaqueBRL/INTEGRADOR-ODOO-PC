// =====================================================================
// CONEXÃO COM O ODOO (nível de módulo: sobrevive entre requisições "quentes")
// =====================================================================
// As credenciais agora vêm das variáveis de ambiente da Vercel (ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY).
// Os valores antigos continuam como reserva para o site não parar, mas o ideal é removê-los daqui.
const ODOO_URL = process.env.ODOO_URL || "https://deuris-candy-2.odoo.com/jsonrpc";
const ODOO_DB = process.env.ODOO_DB || "deuris-candy-2";
const ODOO_USER = process.env.ODOO_USER || "isaquemoises14@gmail.com";
const ODOO_API_KEY = process.env.ODOO_API_KEY || "0757a6c247886172bff32acdceb0122735bb3278";

let cachedUid = null;
let uidPromise = null;
let forcedAccountIdCache = null;

async function rpc(service, method, args) {
    const r = await fetch(ODOO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() })
    });
    return r.json();
}

// Autentica UMA vez e reaproveita o uid (antes eram 2 chamadas ao Odoo a cada clique)
function getUid() {
    if (cachedUid) return Promise.resolve(cachedUid);
    if (!uidPromise) {
        uidPromise = rpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}])
            .then(d => { if (d.result) cachedUid = d.result; return d.result; })
            .finally(() => { uidPromise = null; });
    }
    return uidPromise;
}

const execute = (model, method, args, kwargs = {}) =>
    rpc("object", "execute_kw", [ODOO_DB, cachedUid, ODOO_API_KEY, model, method, args, kwargs]).then(d => {
        if (d.error) {
            const errData = d.error.data || {};
            const msg = errData.message || errData.debug || d.error.message || `Erro desconhecido do Odoo ao chamar ${model}.${method}`;
            throw new Error(msg);
        }
        return d.result;
    });

// Cache em memória para listas que quase não mudam (condições de pagamento, armazéns, locais, produtos...)
const _cache = new Map();
function cached(key, ttlMs, fn) {
    const hit = _cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    const p = fn().catch(err => { _cache.delete(key); throw err; });
    _cache.set(key, { p, exp: Date.now() + ttlMs });
    return p;
}
// Tela de Produtos: tipo "Mercadorias" (consu) + caixa "Vendas" marcada
const PRODUCT_BASE_DOMAIN = [["type", "=", "consu"], ["sale_ok", "=", true]];
const TTL_LONG = 3 * 60 * 1000;
const TTL_PRODUCTS = 20 * 1000;
const lookups = {
    paymentTerms: () => cached("payment_terms", TTL_LONG, () => execute("account.payment.term", "search_read", [[]], { fields: ["id", "name"] })),
    warehouses: () => cached("warehouses", TTL_LONG, () => execute("stock.warehouse", "search_read", [[]], { fields: ["id", "name", "code"] })),
    saleProducts: () => cached("sale_products", TTL_PRODUCTS, () => execute("product.product", "search_read", [[["sale_ok", "=", true]]], { fields: ["id", "display_name", "list_price"] })),
    locations: () => cached("locations", TTL_LONG, () => execute("stock.location", "search_read", [[["usage", "=", "internal"]]], { fields: ["id", "complete_name"], limit: 200 })),
    transferProducts: () => cached("transfer_products", TTL_PRODUCTS, () => execute("product.product", "search_read", [[["type", "!=", "service"]]], { fields: ["id", "display_name", "uom_id"], limit: 200 })),
    journals: () => cached("journals", TTL_LONG, () => execute("account.journal", "search_read", [[["type", "in", ["bank", "cash"]]]], { fields: ["id", "name", "type", "default_account_id"] })),
    internalPickingTypes: () => cached("picking_types_internal", TTL_LONG, () => execute("stock.picking.type", "search_read", [[["code", "=", "internal"]]], { fields: ["id", "name", "default_location_src_id", "default_location_dest_id"] }))
};

// Contas de caixa/banco (mesmo critério da tela Financeiro), incluindo as de saldo zero
async function getCashBankAccounts() {
    const accounts = await execute("account.account", "search_read", [[["account_type", "in", ["asset_cash", "bank_and_cash"]]]], {
        fields: ["id", "code", "name"],
        order: "code asc",
        limit: 200
    });
    return accounts || [];
}

// Contas para pagamento de fatura: SOMENTE contas do tipo "Banco e caixa" (plano de contas).
// O Odoo registra o pagamento por diário, então cada conta é ligada ao diário que a usa como conta padrão.
async function getPaymentAccounts() {
    const [accounts, journals] = await Promise.all([getCashBankAccounts(), lookups.journals()]);
    const journalByAccount = {};
    (journals || []).forEach(j => {
        const accId = Array.isArray(j.default_account_id) ? j.default_account_id[0] : j.default_account_id;
        if (accId && !journalByAccount[accId]) journalByAccount[accId] = j;
    });
    return accounts.map(a => {
        const j = journalByAccount[a.id];
        return { id: j ? j.id : null, account_id: a.id, code: a.code, name: a.name, has_journal: !!j };
    });
}

// Diário "Transferências" (código TRF)
async function getTransferJournal() {
    const journals = await execute("account.journal", "search_read", [["|", ["name", "=", "Transferências"], ["code", "=", "TRF"]]], {
        fields: ["id", "name", "code"],
        limit: 5
    });
    if (!journals || journals.length === 0) return null;
    return journals.find(j => j.name === "Transferências") || journals[0];
}

// Remove de um objeto os campos que não existem naquele modelo do Odoo (evita "Invalid field ..." entre versões)
async function onlyExistingFields(model, vals) {
    try {
        const defs = await cached("fields_" + model, TTL_LONG, () => execute(model, "fields_get", [], { attributes: ["type"] }));
        const out = {};
        for (const k of Object.keys(vals)) {
            if (vals[k] === undefined) continue;
            if (defs && defs[k]) out[k] = vals[k];
            else console.warn("Campo ignorado (não existe em " + model + "):", k);
        }
        return out;
    } catch (e) {
        return vals;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = body.action || "get_products";
    // qualquer ação que grava algo limpa as listas em cache deste servidor
    if (!/^(get_|search_)/.test(action)) _cache.clear();

    try {
        const uid = await getUid();

        if (!uid) {
            return res.status(401).json({ error: "Falha na autenticação com o Odoo." });
        }

        // Encontra o tipo de operação de "Transferência Interna" correspondente ao local de origem
        // (mesma lógica que o próprio Odoo usa para preencher "Tipo de operação" automaticamente)
        const resolveInternalPickingType = async (locationId) => {
            const types = await lookups.internalPickingTypes();
            if (!types || types.length === 0) return null;
            if (locationId) {
                const match = types.find(t => Array.isArray(t.default_location_src_id) && t.default_location_src_id[0] === Number(locationId));
                if (match) return match;
            }
            return types[0];
        };

        // Força todas as linhas de produto de uma fatura a usarem sempre a mesma conta contábil,
        // sem que isso precise aparecer/ser escolhido na tela do nosso site
        const FORCED_INVOICE_ACCOUNT_CODE = "3.01.01.01.01.04";
        const resolveForcedAccountId = async () => {
            if (forcedAccountIdCache) return forcedAccountIdCache;
            const accs = await execute("account.account", "search_read", [[["code", "=", FORCED_INVOICE_ACCOUNT_CODE]]], { fields: ["id"] });
            if (accs && accs.length > 0) {
                forcedAccountIdCache = accs[0].id;
                return forcedAccountIdCache;
            }
            return null;
        };
        const applyForcedAccountToInvoice = async (invoiceId) => {
            const accountId = await resolveForcedAccountId();
            if (!accountId) return;
            const lines = await execute("account.move.line", "search_read", [[["move_id", "=", invoiceId], ["display_type", "=", "product"], ["account_id", "!=", accountId]]], { fields: ["id"] });
            const ids = (lines || []).map(l => l.id);
            if (ids.length > 0) {
                await execute("account.move.line", "write", [ids, { account_id: accountId }]);
            }
        };

        // Gera a fatura (rascunho) usando o assistente "Criar fatura" do Odoo.
        // Métodos privados (que começam com "_", como sale.order._create_invoices) são bloqueados
        // pelo Odoo via API externa; o assistente usa só métodos públicos e faz o mesmo trabalho.
        const criarFaturasDoPedido = async (orderId) => {
            const oid = Number(orderId);
            const ctx = { active_model: "sale.order", active_id: oid, active_ids: [oid] };

            const antes = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
            const idsAntes = (antes && antes[0] && antes[0].invoice_ids) || [];

            const wizardId = await execute("sale.advance.payment.inv", "create", [{ advance_payment_method: "delivered" }], { context: ctx });
            await execute("sale.advance.payment.inv", "create_invoices", [[wizardId]], { context: ctx });

            const depois = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
            const idsDepois = (depois && depois[0] && depois[0].invoice_ids) || [];
            return idsDepois.filter(id => !idsAntes.includes(id));
        };

        // Bloqueia/desbloqueia as entregas CONCLUÍDAS de um pedido (botões "Trancar"/"Desbloquear" da entrega).
        // Entrega desbloqueada = dá para editar produtos e quantidades da entrega pelo pedido de venda.
        const definirBloqueioEntregas = async (orderId, bloquear) => {
            const entregas = await execute("stock.picking", "search_read", [[
                ["sale_id", "=", Number(orderId)], ["state", "=", "done"], ["picking_type_code", "=", "outgoing"]
            ]], { fields: ["id", "is_locked"] });
            for (const e of (entregas || [])) {
                if (!!e.is_locked === !!bloquear) continue;
                try {
                    await execute("stock.picking", "write", [[e.id], { is_locked: !!bloquear }]);
                } catch (err) {
                    await execute("stock.picking", "action_toggle_is_locked", [[e.id]]);
                }
            }
        };

        // Trava/destrava o PEDIDO DE VENDA (botões "Travar"/"Destravar" do Odoo).
        // Pedido destravado = dá para adicionar/excluir produtos e mudar quantidades.
        const definirBloqueioPedido = async (orderId, bloquear) => {
            const oid = Number(orderId);
            const st = await execute("sale.order", "read", [[oid]], { fields: ["state"] });
            if (!st || !st[0] || st[0].state === "cancel" || st[0].state === "draft" || st[0].state === "sent") return;

            let atual;
            let usaCampo = true;
            try {
                // Odoo 17.2+/18/19: campo "locked" (o estado continua "Pedido de venda")
                const r = await execute("sale.order", "read", [[oid]], { fields: ["locked"] });
                atual = !!(r && r[0] && r[0].locked);
            } catch (e) {
                // Odoo mais antigo: pedido travado = estado "done"
                usaCampo = false;
                atual = st[0].state === "done";
            }
            if (atual === !!bloquear) return;

            if (usaCampo) {
                try {
                    await execute("sale.order", "write", [[oid], { locked: !!bloquear }]);
                } catch (e) {
                    await execute("sale.order", bloquear ? "action_lock" : "action_unlock", [[oid]]);
                }
            } else {
                await execute("sale.order", bloquear ? "action_done" : "action_unlock", [[oid]]);
            }
        };

        // Regra: entrega e pedido desbloqueados enquanto a fatura não estiver paga; trancada quando todas as
        // faturas (não canceladas) do pedido estiverem pagas.
        const sincronizarBloqueioEntregas = async (invoiceId) => {
            const pedidos = await execute("sale.order", "search_read", [[["invoice_ids", "in", [Number(invoiceId)]]]], { fields: ["id", "invoice_ids", "state"] });
            for (const ped of (pedidos || [])) {
                if (ped.state === "cancel") continue;
                const faturas = await execute("account.move", "search_read", [[["id", "in", ped.invoice_ids], ["state", "!=", "cancel"]]], { fields: ["id", "payment_state"] });
                const pago = (faturas || []).length > 0 && faturas.every(f => f.payment_state === "paid" || f.payment_state === "in_payment");
                await definirBloqueioEntregas(ped.id, pago);
                await definirBloqueioPedido(ped.id, pago);
            }
        };

        // Faturas ligadas a um pagamento (para atualizar o bloqueio quando o pagamento muda)
        const faturasDoPagamento = async (paymentId) => {
            try {
                const p = await execute("account.payment", "read", [[Number(paymentId)]], { fields: ["reconciled_invoice_ids"] });
                return (p && p[0] && p[0].reconciled_invoice_ids) || [];
            } catch (e) { return []; }
        };
        const sincronizarPorPagamento = async (invoiceIds) => {
            for (const id of (invoiceIds || [])) {
                try { await sincronizarBloqueioEntregas(id); } catch (e) { /* melhor esforço */ }
            }
        };

        // Valida um picking e responde às janelas de confirmação do Odoo (ex.: criar pendência)
        const validarPickingComAssistentes = async (pickingId) => {
            const vr = await execute("stock.picking", "button_validate", [[Number(pickingId)]], { context: { skip_sms: true } });
            if (vr && typeof vr === "object" && vr.res_model) {
                const wctx = Object.assign({}, vr.context || {}, { skip_sms: true });
                const wid = await execute(vr.res_model, "create", [{}], { context: wctx });
                const metodo = vr.res_model === "stock.backorder.confirmation" ? "process_cancel_backorder" : "process";
                await execute(vr.res_model, metodo, [[wid]], { context: wctx });
            }
        };

        // Mantém UMA ÚNICA entrega por pedido, sempre igual às linhas do pedido (produto e quantidade).
        // 1) cancela entregas extras que o Odoo cria ao aumentar/adicionar itens;
        // 2) ajusta a entrega concluída (desbloqueada): muda quantidades, inclui produtos novos, tira os removidos.
        const sincronizarEntregaComPedido = async (orderId) => {
            const oid = Number(orderId);
            const avisos = [];

            // 1) entregas extras pendentes
            const pendentes = await execute("stock.picking", "search_read", [[
                ["sale_id", "=", oid], ["picking_type_code", "=", "outgoing"], ["state", "not in", ["done", "cancel"]]
            ]], { fields: ["id", "name"] });
            for (const p of (pendentes || [])) {
                try {
                    await execute("stock.picking", "action_cancel", [[p.id]]);
                } catch (e) {
                    avisos.push("Não foi possível cancelar a entrega extra " + p.name + ": " + e.message);
                }
            }

            // 2) entrega principal (a concluída mais antiga)
            const feitas = await execute("stock.picking", "search_read", [[
                ["sale_id", "=", oid], ["picking_type_code", "=", "outgoing"], ["state", "=", "done"]
            ]], { fields: ["id", "name", "location_id", "location_dest_id", "picking_type_id", "is_locked"], order: "id asc" }).catch(() => []);
            if (!feitas || feitas.length === 0) {
                avisos.push("O pedido não tem entrega concluída para ajustar. Confira a entrega no Odoo.");
                return avisos;
            }
            const principal = feitas[0];
            if (feitas.length > 1) {
                avisos.push("Este pedido tem mais de uma entrega concluída; só a " + principal.name + " foi ajustada.");
            }
            try { await definirBloqueioEntregas(oid, false); } catch (e) { /* segue mesmo assim */ }

            const linhas = await execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], { fields: ["id", "product_id", "product_uom_qty"] });
            const movimentos = await execute("stock.move", "search_read", [[["picking_id", "=", principal.id], ["state", "!=", "cancel"]]], { fields: ["id", "product_id", "product_uom_qty", "quantity", "state", "sale_line_id"] });

            const idsLinhas = (linhas || []).map(l => l.id);
            const novas = [];

            for (const l of (linhas || [])) {
                const qtd = Number(l.product_uom_qty);
                const mv = (movimentos || []).find(m => Array.isArray(m.sale_line_id) && m.sale_line_id[0] === l.id);
                const nomeProd = Array.isArray(l.product_id) ? l.product_id[1] : "";
                if (!mv) { novas.push(l); continue; }
                if (Number(mv.product_uom_qty) === qtd && Number(mv.quantity) === qtd) continue;
                try {
                    try {
                        await execute("stock.move", "write", [[mv.id], { product_uom_qty: qtd, quantity: qtd }]);
                    } catch (e1) {
                        await execute("stock.move", "write", [[mv.id], { product_uom_qty: qtd }]);
                        await execute("stock.move", "write", [[mv.id], { quantity: qtd }]);
                    }
                } catch (e) {
                    // a quantidade da entrega já foi espelhada antes da alteração do pedido; erro aqui é ignorado
                    console.warn("Ajuste de quantidade na entrega ignorado (" + nomeProd + "): " + e.message);
                }
            }

            // produtos que saíram do pedido: retira da entrega (ou zera, se o Odoo não deixar excluir)
            const orfaos = (movimentos || []).filter(m => !(Array.isArray(m.sale_line_id) && idsLinhas.includes(m.sale_line_id[0])));
            for (const m of orfaos) {
                const nome = Array.isArray(m.product_id) ? m.product_id[1] : "";
                try {
                    await execute("stock.move", "unlink", [[m.id]]);
                } catch (e1) {
                    try {
                        await execute("stock.move", "write", [[m.id], { product_uom_qty: 0, quantity: 0 }]);
                    } catch (e2) {
                        avisos.push("Não foi possível retirar " + nome + " da entrega: " + e2.message);
                    }
                }
            }

            // produtos novos no pedido: entram na MESMA entrega
            if (novas.length > 0) {
                try {
                    const locOrigem = Array.isArray(principal.location_id) ? principal.location_id[0] : principal.location_id;
                    const locDestino = Array.isArray(principal.location_dest_id) ? principal.location_dest_id[0] : principal.location_dest_id;
                    const tipoId = Array.isArray(principal.picking_type_id) ? principal.picking_type_id[0] : principal.picking_type_id;
                    const novosIds = [];
                    for (const l of novas) {
                        const prodId = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
                        const prod = await execute("product.product", "read", [[prodId]], { fields: ["uom_id", "display_name"] });
                        const uom = prod && prod[0] && Array.isArray(prod[0].uom_id) ? prod[0].uom_id[0] : null;
                        const vals = await onlyExistingFields("stock.move", {
                            picking_id: principal.id,
                            product_id: prodId,
                            product_uom_qty: Number(l.product_uom_qty),
                            product_uom: uom,
                            uom_id: uom,
                            name: prod && prod[0] ? prod[0].display_name : "",
                            location_id: locOrigem,
                            location_dest_id: locDestino,
                            picking_type_id: tipoId,
                            sale_line_id: l.id
                        });
                        novosIds.push(await execute("stock.move", "create", [vals]));
                    }
                    await execute("stock.picking", "action_confirm", [[principal.id]]);
                    await execute("stock.picking", "action_assign", [[principal.id]]).catch(() => {});
                    for (const mid of novosIds) {
                        const dem = await execute("stock.move", "read", [[mid]], { fields: ["product_uom_qty"] });
                        const q = dem && dem[0] ? dem[0].product_uom_qty : 0;
                        try {
                            await execute("stock.move", "write", [[mid], { quantity: q }]);
                        } catch (e2) {
                            await execute("stock.move", "write", [[mid], { quantity_done: q }]).catch(() => {});
                        }
                    }
                    await validarPickingComAssistentes(principal.id);
                } catch (e) {
                    avisos.push("Não foi possível incluir os produtos novos na entrega: " + e.message);
                }
            }

            // a validação pode ter trancado a entrega de novo
            try { await definirBloqueioEntregas(oid, false); } catch (e) { /* ok */ }
            return avisos;
        };

        // Coloca a data de vencimento escolhida na tela no campo "Data de vencimento" da fatura.
        // A fatura é criada sem condição de pagamento, então esse campo fica livre para receber a data.
        const aplicarVencimentoNaFatura = async (invoiceId, dueDate) => {
            if (!invoiceId || !dueDate) return;
            await execute("account.move", "write", [[Number(invoiceId)], { invoice_date_due: dueDate }]);
        };

        // Mantém a(s) fatura(s) PROVISÓRIA(S) (rascunho) do pedido idênticas às linhas do pedido de venda:
        // atualiza quantidade/preço/desconto, cria as linhas novas e apaga as que saíram do pedido.
        // Faturas já lançadas (posted) nunca são mexidas aqui.
        const sincronizarFaturaProvisoriaComPedido = async (orderId) => {
            const oid = Number(orderId);
            const ped = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
            const ids = (ped && ped[0] && ped[0].invoice_ids) || [];
            if (ids.length === 0) return;

            const rascunhos = await execute("account.move", "search_read", [[["id", "in", ids], ["state", "=", "draft"], ["move_type", "=", "out_invoice"]]], { fields: ["id"] });
            if (!rascunhos || rascunhos.length === 0) return;

            // Nomes dos campos mudam entre versões do Odoo (tax_id/tax_ids, product_uom/product_uom_id)
            let defsSol = {};
            try { defsSol = await execute("sale.order.line", "fields_get", [], { attributes: ["type"] }) || {}; } catch (e) { defsSol = {}; }
            const campoImposto = defsSol.tax_ids ? "tax_ids" : (defsSol.tax_id ? "tax_id" : null);
            const campoUnidade = defsSol.product_uom_id ? "product_uom_id" : (defsSol.product_uom ? "product_uom" : null);
            const camposSol = ["id", "product_id", "name", "product_uom_qty", "price_unit", "discount"];
            if (campoImposto) camposSol.push(campoImposto);
            if (campoUnidade) camposSol.push(campoUnidade);
            const sols = await execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], { fields: camposSol });
            const solIds = new Set((sols || []).map(s => s.id));
            const diferente = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) > 0.000001;

            for (const f of rascunhos) {
                const linhas = await execute("account.move.line", "search_read", [[["move_id", "=", f.id], ["display_type", "=", "product"]]], {
                    fields: ["id", "sale_line_ids", "quantity", "price_unit", "discount"]
                });

                const cmds = [];
                const porSol = {};
                for (const l of (linhas || [])) {
                    const solId = (l.sale_line_ids || []).find(id => solIds.has(id));
                    if (solId && !porSol[solId]) porSol[solId] = l;
                    else cmds.push([2, l.id, 0]); // linha que saiu do pedido (ou duplicada)
                }

                for (const s of (sols || [])) {
                    const l = porSol[s.id];
                    if (l) {
                        const vals = {};
                        if (diferente(l.quantity, s.product_uom_qty)) vals.quantity = s.product_uom_qty;
                        if (Object.keys(vals).length > 0) cmds.push([1, l.id, vals]);
                    } else {
                        const vals = await onlyExistingFields("account.move.line", {
                            product_id: Array.isArray(s.product_id) ? s.product_id[0] : s.product_id,
                            name: s.name,
                            quantity: s.product_uom_qty,
                            price_unit: s.price_unit,
                            discount: s.discount || 0,
                            product_uom_id: campoUnidade && Array.isArray(s[campoUnidade]) ? s[campoUnidade][0] : undefined,
                            tax_ids: [[6, 0, (campoImposto && s[campoImposto]) || []]],
                            sale_line_ids: [[6, 0, [s.id]]]
                        });
                        cmds.push([0, 0, vals]);
                    }
                }

                if (cmds.length > 0) {
                    await execute("account.move", "write", [[f.id], { invoice_line_ids: cmds }]);
                }
                await applyForcedAccountToInvoice(f.id);
            }
        };

        // Devolve ao estoque de origem os itens de todas as entregas JÁ CONCLUÍDAS de um pedido
        // (mesmo processo manual do Odoo: entrega > "Devolução" > criar devolução > "Validar" o recebimento).
        // Só devolve o que ainda não foi devolvido, então chamar de novo não duplica a devolução.
        const devolverEntregasDoPedido = async (orderId) => {
            const oid = Number(orderId);
            const devolvidos = [];
            const avisos = [];

            const pickings = await execute("stock.picking", "search_read", [[
                ["sale_id", "=", oid], ["state", "=", "done"], ["picking_type_code", "=", "outgoing"]
            ]], { fields: ["id", "name", "location_id", "location_dest_id", "picking_type_id", "partner_id"] });

            for (const p of (pickings || [])) {
                try {
                    // 1) o que saiu nesta entrega
                    let moves;
                    try {
                        moves = await execute("stock.move", "search_read", [[["picking_id", "=", p.id], ["state", "=", "done"]]], { fields: ["id", "quantity"] });
                    } catch (e) {
                        moves = await execute("stock.move", "search_read", [[["picking_id", "=", p.id], ["state", "=", "done"]]], { fields: ["id", "quantity_done"] });
                        moves = moves.map(m => ({ id: m.id, quantity: m.quantity_done }));
                    }
                    const moveIds = (moves || []).map(m => m.id);
                    if (moveIds.length === 0) continue;

                    // 2) o que já foi devolvido antes (evita devolver duas vezes)
                    const jaDevolvidos = await execute("stock.move", "search_read", [[["origin_returned_move_id", "in", moveIds], ["state", "!=", "cancel"]]], {
                        fields: ["origin_returned_move_id", "product_uom_qty", "quantity", "state"]
                    }).catch(() => []);
                    const devolvidoPorMove = {};
                    (jaDevolvidos || []).forEach(r => {
                        const origem = Array.isArray(r.origin_returned_move_id) ? r.origin_returned_move_id[0] : r.origin_returned_move_id;
                        const qtd = r.state === "done" ? (r.quantity || 0) : (r.product_uom_qty || 0);
                        devolvidoPorMove[origem] = (devolvidoPorMove[origem] || 0) + qtd;
                    });

                    const restante = {};
                    let temAlgoParaDevolver = false;
                    moves.forEach(m => {
                        restante[m.id] = Math.max(0, (m.quantity || 0) - (devolvidoPorMove[m.id] || 0));
                        if (restante[m.id] > 0) temAlgoParaDevolver = true;
                    });
                    if (!temAlgoParaDevolver) continue;

                    // 3) cria o recebimento de devolução (o que o botão "Devolução" faz no Odoo).
                    // Nesta versão do Odoo o assistente "stock.return.picking" não existe mais:
                    // o botão cria direto um recebimento em rascunho, e é isso que fazemos aqui,
                    // já com a "Demanda" igual à quantidade que saiu no pedido.
                    const origemId = Array.isArray(p.location_id) ? p.location_id[0] : p.location_id;      // estoque de onde saiu
                    const clienteLocId = Array.isArray(p.location_dest_id) ? p.location_dest_id[0] : p.location_dest_id;
                    const tipoOrigemId = Array.isArray(p.picking_type_id) ? p.picking_type_id[0] : p.picking_type_id;

                    // tipo de operação de devolução ("Recebimentos") definido no tipo da entrega
                    let tipoDevolucaoId = null;
                    let armazemTipoId = null;
                    try {
                        const defsTipo = await onlyExistingFields("stock.picking.type", { return_picking_type_id: 1, warehouse_id: 1 });
                        const camposTipo = Object.keys(defsTipo);
                        if (camposTipo.length > 0) {
                            const tp = await execute("stock.picking.type", "read", [[tipoOrigemId]], { fields: camposTipo });
                            if (tp && tp[0] && Array.isArray(tp[0].return_picking_type_id)) tipoDevolucaoId = tp[0].return_picking_type_id[0];
                            if (tp && tp[0] && Array.isArray(tp[0].warehouse_id)) armazemTipoId = tp[0].warehouse_id[0];
                        }
                    } catch (e) { /* tenta o plano B abaixo */ }
                    if (!tipoDevolucaoId) {
                        // plano B: tipo "Recebimentos" do mesmo armazém da entrega
                        const dom = [["code", "=", "incoming"]];
                        if (armazemTipoId) dom.push(["warehouse_id", "=", armazemTipoId]);
                        const incoming = await execute("stock.picking.type", "search_read", [dom], { fields: ["id"], limit: 1 }).catch(() => []);
                        if (incoming && incoming[0]) tipoDevolucaoId = incoming[0].id;
                    }
                    if (!tipoDevolucaoId) throw new Error("não foi encontrado o tipo de operação de devolução (Recebimentos) deste local");

                    // linhas originais completas (para copiar produto e unidade de medida)
                    const movesCompletos = await execute("stock.move", "read", [moveIds]);
                    const moveCommands = [];
                    for (const mv of movesCompletos) {
                        const qtd = restante[mv.id] || 0;
                        if (qtd <= 0) continue;
                        const uom = Array.isArray(mv.product_uom) ? mv.product_uom[0] : (Array.isArray(mv.uom_id) ? mv.uom_id[0] : null);
                        const vals = await onlyExistingFields("stock.move", {
                            product_id: Array.isArray(mv.product_id) ? mv.product_id[0] : mv.product_id,
                            product_uom_qty: qtd,
                            product_uom: uom,
                            uom_id: uom,
                            location_id: clienteLocId,
                            location_dest_id: origemId,
                            origin_returned_move_id: mv.id,
                            picking_type_id: tipoDevolucaoId,
                            origin: "Devolução de " + p.name
                        });
                        moveCommands.push([0, 0, vals]);
                    }

                    const pickingVals = await onlyExistingFields("stock.picking", {
                        picking_type_id: tipoDevolucaoId,
                        partner_id: Array.isArray(p.partner_id) ? p.partner_id[0] : false,
                        origin: "Devolução de " + p.name,
                        location_id: clienteLocId,
                        location_dest_id: origemId,
                        return_id: p.id,
                        move_ids: moveCommands
                    });
                    const novoId = await execute("stock.picking", "create", [pickingVals]);
                    if (!novoId) throw new Error("o Odoo não criou o recebimento de devolução");

                    // 4) validar o recebimento (botão "Validar" do Odoo), com a quantidade devolvida
                    let info = await execute("stock.picking", "read", [[novoId]], { fields: ["name", "state"] });
                    if (info[0].state === "draft") {
                        await execute("stock.picking", "action_confirm", [[novoId]]);
                    }
                    const novosMoves = await execute("stock.move", "search_read", [[["picking_id", "=", novoId]]], { fields: ["id", "product_uom_qty"] });
                    for (const mv of (novosMoves || [])) {
                        try {
                            await execute("stock.move", "write", [[mv.id], { quantity: mv.product_uom_qty }]);
                        } catch (e2) {
                            await execute("stock.move", "write", [[mv.id], { quantity_done: mv.product_uom_qty }]).catch(() => {});
                        }
                    }

                    const vr = await execute("stock.picking", "button_validate", [[novoId]], { context: { skip_sms: true } });
                    // se o Odoo abrir uma janela de confirmação (ex.: criar pendência), responde por ela
                    if (vr && typeof vr === "object" && vr.res_model) {
                        const wctx = Object.assign({}, vr.context || {}, { skip_sms: true });
                        const wid2 = await execute(vr.res_model, "create", [{}], { context: wctx });
                        const metodo = vr.res_model === "stock.backorder.confirmation" ? "process_cancel_backorder" : "process";
                        await execute(vr.res_model, metodo, [[wid2]], { context: wctx });
                    }

                    info = await execute("stock.picking", "read", [[novoId]], { fields: ["name", "state"] });
                    if (info[0].state === "done") {
                        devolvidos.push(info[0].name);
                    } else {
                        avisos.push("A devolução " + info[0].name + " foi criada, mas não foi validada. Valide-a no Odoo para o item voltar ao estoque.");
                    }
                } catch (e) {
                    avisos.push("Não foi possível devolver ao estoque a entrega " + p.name + ": " + e.message + " Faça a devolução manualmente no Odoo.");
                }
            }
            return { devolvidos, avisos };
        };

        // Quando a geração da fatura não gera nenhuma fatura (sem lançar erro), busca o motivo
        // olhando quanto já foi pedido/entregue/faturado em cada linha, para explicar na mensagem
        const diagnosticarPedidoSemFatura = async (orderId) => {
            try {
                const orders = await execute("sale.order", "search_read", [[["id", "=", Number(orderId)]]], { fields: ["invoice_status"] });
                const statusLabels = { no: "nada a faturar", to_invoice: "a faturar", invoiced: "já totalmente faturado", upselling: "faturamento adicional disponível" };
                const orderStatus = orders && orders[0] ? (statusLabels[orders[0].invoice_status] || orders[0].invoice_status) : "desconhecido";

                const lines = await execute("sale.order.line", "search_read", [[["order_id", "=", Number(orderId)], ["display_type", "=", false]]], {
                    fields: ["product_id", "product_uom_qty", "qty_delivered", "qty_invoiced"]
                });
                const linesTxt = (lines || []).map(l => {
                    const name = Array.isArray(l.product_id) ? l.product_id[1] : String(l.product_id);
                    return `${name} (pedido: ${l.product_uom_qty}, entregue: ${l.qty_delivered}, já faturado: ${l.qty_invoiced})`;
                }).join("; ");

                return ` Status de faturamento do pedido: ${orderStatus}. ${linesTxt}`;
            } catch (e) {
                return "";
            }
        };

        // AÇÃO: BUSCAR PAGAMENTOS DA FATURA
        if (action === "get_invoice_payments") {
            const { order_id } = body;
            if (!order_id) return res.status(400).json({ error: "ID da fatura é obrigatório." });

            const invoice = await execute("account.move", "read", [[Number(order_id)]], {
                fields: ["invoice_payments_widget"]
            });

            let paymentIds = [];
            if (invoice && invoice[0] && invoice[0].invoice_payments_widget) {
                const widgetData = typeof invoice[0].invoice_payments_widget === 'string' 
                    ? JSON.parse(invoice[0].invoice_payments_widget) 
                    : invoice[0].invoice_payments_widget;

                if (widgetData && widgetData.content) {
                    paymentIds = widgetData.content.map(p => p.account_payment_id).filter(Boolean);
                }
            }

            if (paymentIds.length === 0) {
                const paymentsFound = await execute("account.payment", "search_read", [[["ref", "ilike", order_id]]], {
                    fields: ["id", "name", "amount", "date", "state", "journal_id", "partner_id"]
                });
                return res.status(200).json({ payments: paymentsFound || [] });
            }

            const payments = await execute("account.payment", "search_read", [[["id", "in", paymentIds]]], {
                fields: ["id", "name", "amount", "date", "state", "journal_id", "partner_id"]
            });

            return res.status(200).json({ payments: payments || [] });
        }

        // AÇÃO: MUDAR PAGAMENTO PARA PROVISÓRIO (VOLTAR PARA PROVISÓRIO)
        if (action === "unpost_payment") {
            const { payment_id } = body;
            if (!payment_id) return res.status(400).json({ error: "ID do pagamento é obrigatório." });

            const faturasAntes = await faturasDoPagamento(payment_id);
            await execute("account.payment", "action_draft", [[Number(payment_id)]]);
            await sincronizarPorPagamento(faturasAntes);
            return res.status(200).json({ success: true });
        }

        // AÇÃO: LANÇAR / CONFIRMAR PAGAMENTO NO ODOO
        if (action === "post_payment") {
            const { payment_id } = body;
            if (!payment_id) return res.status(400).json({ error: "ID do pagamento é obrigatório." });

            await execute("account.payment", "action_post", [[Number(payment_id)]]);
            await sincronizarPorPagamento(await faturasDoPagamento(payment_id));
            return res.status(200).json({ success: true });
        }

        // AÇÃO: ATUALIZAR PAGAMENTO
        if (action === "update_payment") {
            const { payment_id, journal_id, amount, date } = body;
            if (!payment_id) return res.status(400).json({ error: "ID do pagamento é obrigatório." });

            const writeData = {};
            if (journal_id) writeData.journal_id = Number(journal_id);
            if (amount !== undefined) writeData.amount = Number(amount);
            if (date) writeData.date = date;

            await execute("account.payment", "write", [[Number(payment_id)], writeData]);
            return res.status(200).json({ success: true });
        }

        // AÇÃO: EXCLUIR PAGAMENTO (APENAS SE ESTIVER EM PROVISÓRIO)
        if (action === "delete_payment") {
            const { payment_id } = body;
            if (!payment_id) return res.status(400).json({ error: "ID do pagamento é obrigatório." });

            await execute("account.payment", "unlink", [[Number(payment_id)]]);
            return res.status(200).json({ success: true });
        }

        // AÇÃO: BUSCAR DIÁRIOS / CONTAS DE PAGAMENTO (BANCO/CAIXA)
        if (action === "get_payment_journals") {
            const accounts = await getPaymentAccounts();
            return res.status(200).json({ result: accounts });
        }

        // AÇÃO: REGISTRAR PAGAMENTO DA FATURA
        // Se a fatura ainda estiver PROVISÓRIA (rascunho), ela só é lançada aqui, junto com o pagamento.
        // Se qualquer etapa falhar depois de lançar, a fatura volta para Provisória.
        if (action === "register_payment") {
            const { order_id, journal_id, amount, payment_date, invoice_date } = body;
            if (!order_id || !journal_id || !amount) {
                return res.status(400).json({ error: "Campos obrigatórios não informados." });
            }

            // Só aceita contas do tipo "Banco e caixa"
            const allowedAccounts = await getPaymentAccounts();
            if (!allowedAccounts.some(a => a.has_journal && a.id === Number(journal_id))) {
                return res.status(400).json({ error: "Conta inválida: só são permitidas contas do tipo Banco e caixa." });
            }

            const invoiceId = Number(order_id);
            const faturas = await execute("account.move", "read", [[invoiceId]], { fields: ["state"] });
            if (!faturas || faturas.length === 0) return res.status(404).json({ error: "Fatura não encontrada." });

            let lancadaAgora = false;
            try {
                if (faturas[0].state === "draft") {
                    // garante que a fatura reflete o pedido antes de lançar
                    const peds = await execute("sale.order", "search_read", [[["invoice_ids", "in", [invoiceId]]]], { fields: ["id"] });
                    for (const p of (peds || [])) await sincronizarFaturaProvisoriaComPedido(p.id);

                    if (invoice_date) {
                        await execute("account.move", "write", [[invoiceId], { invoice_date }]);
                    }
                    await execute("account.move", "action_post", [[invoiceId]]);
                    lancadaAgora = true;
                } else if (faturas[0].state === "cancel") {
                    return res.status(400).json({ error: "Esta fatura está cancelada." });
                }

                const ctx = { active_model: "account.move", active_ids: [invoiceId] };
                const wizardId = await execute("account.payment.register", "create", [{
                    journal_id: Number(journal_id),
                    amount: Number(amount),
                    payment_date: payment_date || false
                }], { context: ctx });

                if (!wizardId) throw new Error("Não foi possível gerar o pagamento no Odoo.");

                await execute("account.payment.register", "action_create_payments", [[wizardId]], { context: ctx });
            } catch (e) {
                if (lancadaAgora) {
                    try { await execute("account.move", "button_draft", [[invoiceId]]); } catch (e2) { /* melhor esforço */ }
                }
                return res.status(500).json({ error: "Não foi possível registrar o pagamento: " + e.message + (lancadaAgora ? " A fatura continua Provisória." : "") });
            }

            // Fatura paga => tranca a entrega do pedido
            try { await sincronizarBloqueioEntregas(invoiceId); } catch (e) { /* melhor esforço */ }
            return res.status(200).json({ success: true });
        }

        // AÇÃO: BUSCAR CONTAS FINANCEIRAS E SALDO
        if (action === "get_financial_accounts") {
            const query = body.query || "";
            const domain = [["account_type", "in", ["asset_cash", "bank_and_cash"]]];
            
            if (query) {
                domain.push('|', ['name', 'ilike', query], ['code', 'ilike', query]);
            }

            let accounts = await execute("account.account", "search_read", [domain], {
                fields: ["id", "code", "name", "account_type", "current_balance"],
                limit: 100,
                order: "code asc"
            });

            // Uma única consulta agrupada traz o saldo de todas as contas de uma vez
            const balanceById = {};
            const accountIds = (accounts || []).map(a => a.id);
            if (accountIds.length > 0) {
                try {
                    const groups = await execute("account.move.line", "read_group", [
                        [["account_id", "in", accountIds], ["parent_state", "=", "posted"]]
                    ], {
                        groupby: ["account_id"],
                        fields: ["balance"]
                    });
                    (groups || []).forEach(g => {
                        if (Array.isArray(g.account_id)) balanceById[g.account_id[0]] = g.balance;
                    });
                } catch (e) {}
            }

            // Todas as contas do tipo "Banco e caixa", mesmo com saldo zerado
            const formattedAccounts = (accounts || [])
                .map(acc => ({
                    id: acc.id,
                    code: acc.code || "-",
                    name: acc.name || "-",
                    type: acc.account_type || "-",
                    balance: balanceById[acc.id] ?? acc.current_balance ?? 0
                }));

            return res.status(200).json({ result: formattedAccounts });
        }

        // AÇÃO: EXTRATO (LANÇAMENTOS DE DIÁRIO) SOMENTE DAS CONTAS "BANCO E CAIXA"
        // Filtros opcionais: date_from / date_to (AAAA-MM-DD), partner (texto), account_id
        if (action === "get_account_statement") {
            const accounts = await getCashBankAccounts();
            const accountIds = accounts.map(a => a.id);
            const accountsOut = accounts.map(a => ({ id: a.id, code: a.code, name: a.name }));
            if (accountIds.length === 0) return res.status(200).json({ result: [], accounts: [], limit: 200 });

            const LIMIT = 200;
            const chosen = Number(body.account_id);
            const scopeIds = chosen && accountIds.includes(chosen) ? [chosen] : accountIds;

            const domain = [
                ["state", "=", "posted"],
                ["line_ids.account_id", "in", scopeIds]
            ];

            // Só diários de banco/caixa (+ o diário "Transferências" usado nas transferências entre contas);
            // lançamentos de "Operações diversas" (saldo inicial etc.) ficam de fora
            const trfJournal = await getTransferJournal().catch(() => null);
            if (trfJournal) {
                domain.push("|", ["journal_id.type", "in", ["bank", "cash"]], ["journal_id", "=", trfJournal.id]);
            } else {
                domain.push(["journal_id.type", "in", ["bank", "cash"]]);
            }

            if (body.date_from) domain.push(["date", ">=", body.date_from]);
            if (body.date_to) domain.push(["date", "<=", body.date_to]);
            if (body.partner) domain.push(["partner_id.name", "ilike", String(body.partner)]);

            const moves = await execute("account.move", "search_read", [domain], {
                fields: ["id", "date", "name", "partner_id", "journal_id", "amount_total"],
                order: "date desc, id desc",
                limit: LIMIT
            });

            const result = (moves || []).map(m => ({
                id: m.id,
                date: m.date || "",
                number: m.name || "",
                partner: Array.isArray(m.partner_id) ? m.partner_id[1] : "",
                journal: Array.isArray(m.journal_id) ? m.journal_id[1] : "",
                total: m.amount_total || 0
            }));
            return res.status(200).json({ result, accounts: accountsOut, limit: LIMIT });
        }

        // AÇÃO: DADOS DE APOIO PARA MONTAR UM NOVO PEDIDO DE VENDA (CONDIÇÕES DE PAGAMENTO, PRODUTOS, ARMAZÉNS)
        if (action === "get_sale_form_data") {
            const [paymentTerms, products, warehouses] = await Promise.all([
                lookups.paymentTerms().catch(() => []),
                lookups.saleProducts().catch(() => []),
                lookups.warehouses().catch(() => [])
            ]);
            return res.status(200).json({ payment_terms: paymentTerms || [], products: products || [], warehouses: warehouses || [] });
        }

        // AÇÃO: BUSCAR ARMAZÉNS (LOCAIS DE ESTOQUE PARA VENDA)
        if (action === "get_warehouses") {
            const warehouses = await lookups.warehouses();
            return res.status(200).json({ result: warehouses || [] });
        }

        // AÇÃO: PRODUTOS COM ESTOQUE EM UM ARMAZÉM (para as linhas do pedido de venda)
        if (action === "get_warehouse_products") {
            const whId = Number(body.warehouse_id) || 0;
            if (!whId) return res.status(400).json({ error: "Armazém é obrigatório." });

            const whs = await execute("stock.warehouse", "read", [[whId]], { fields: ["view_location_id", "lot_stock_id"] });
            const wh = whs && whs[0];
            if (!wh) return res.status(404).json({ error: "Armazém não encontrado." });
            // usa o local de estoque do armazém (ex.: "CASA/Stock") e sublocais, o mesmo que aparece em Relatórios > Detailed Stock
            const rootLoc = Array.isArray(wh.lot_stock_id) ? wh.lot_stock_id[0] : wh.view_location_id[0];

            // estoque físico do armazém (locais internos dele e sublocais), somado por produto
            const quants = await execute("stock.quant", "search_read", [[
                ["location_id", "child_of", rootLoc],
                ["location_id.usage", "=", "internal"],
                ["quantity", ">", 0]
            ]], { fields: ["product_id", "quantity"], limit: 10000 });

            const qtyByProduct = {};
            (quants || []).forEach(q => {
                if (!Array.isArray(q.product_id)) return;
                qtyByProduct[q.product_id[0]] = (qtyByProduct[q.product_id[0]] || 0) + q.quantity;
            });
            const ids = Object.keys(qtyByProduct).map(Number);
            if (ids.length === 0) return res.status(200).json({ products: [] });

            // OBS: não usar order "display_name" aqui — é um campo calculado (não armazenado) e o Odoo rejeita a ordenação.
            // A ordem alfabética é feita aqui no servidor.
            const products = await execute("product.product", "search_read", [[["id", "in", ids], ["sale_ok", "=", true]]], {
                fields: ["id", "display_name", "list_price"]
            });
            const list = (products || [])
                .map(pr => ({ ...pr, stock_qty: qtyByProduct[pr.id] }))
                .sort((a, b) => (a.display_name || "").localeCompare(b.display_name || "", "pt-BR"));
            return res.status(200).json({ products: list });
        }

        // AÇÃO: ATUALIZAR PRODUTO
        if (action === "update_product") {
            const { product_id, name, list_price, standard_price, categ_id } = body;
            if (!product_id) return res.status(400).json({ error: "ID do produto é obrigatório." });

            const writeData = {};
            if (name) writeData.name = name;
            if (list_price !== undefined) writeData.list_price = Number(list_price);
            if (standard_price !== undefined) writeData.standard_price = Number(standard_price);
            if (categ_id) writeData.categ_id = Number(categ_id);

            await execute("product.template", "write", [[Number(product_id)], writeData]);
            _cache.delete("sale_products");
            _cache.delete("transfer_products");
            _cache.delete("product_categories");
            return res.status(200).json({ success: true });
        }

        // AÇÃO: EXCLUIR PEDIDO DE VENDA (SOMENTE ORÇAMENTO)
        if (action === "delete_sale_order") {
            const { order_id } = body;
            if (!order_id) {
                return res.status(400).json({ error: "ID do pedido é obrigatório." });
            }
            await execute("sale.order", "unlink", [[Number(order_id)]]);
            return res.status(200).json({ success: true });
        }

        // AÇÃO: CANCELAR PEDIDO DE VENDA
        if (action === "cancel_sale_order") {
            const { order_id } = body;
            if (!order_id) {
                return res.status(400).json({ error: "ID do pedido é obrigatório." });
            }
            const oid = Number(order_id);
            const ctx = { disable_cancel_warning: true };

            // O Odoo não deixa cancelar pedido BLOQUEADO: é preciso destravar antes.
            let estavaBloqueado = false;
            try {
                const info = await execute("sale.order", "read", [[oid]], { fields: ["state", "locked"] });
                estavaBloqueado = !!(info && info[0] && info[0].locked);
            } catch (e) {
                // versões do Odoo sem o campo "locked": o bloqueio era o estado "done"
                const info = await execute("sale.order", "read", [[oid]], { fields: ["state"] });
                estavaBloqueado = !!(info && info[0] && info[0].state === "done");
            }

            if (estavaBloqueado) {
                await execute("sale.order", "action_unlock", [[oid]]);
            }

            try {
                await execute("sale.order", "action_cancel", [[oid]], { context: ctx });
            } catch (e) {
                // se não deu para cancelar, devolve o pedido ao estado bloqueado em que estava
                if (estavaBloqueado) {
                    await execute("sale.order", "action_lock", [[oid]]).catch(() => {});
                }
                throw e;
            }

            // Pedido cancelado: devolve ao estoque de origem o que já tinha sido entregue
            let devolvidos = [];
            let warnings = [];
            try {
                const r = await devolverEntregasDoPedido(oid);
                devolvidos = r.devolvidos;
                warnings = r.avisos;
            } catch (e) {
                warnings.push("Pedido cancelado, mas não foi possível devolver o item ao estoque: " + e.message + " Faça a devolução manualmente no Odoo.");
            }
            return res.status(200).json({ success: true, devolvidos, warnings });
        }

        // AÇÃO: REABRIR PEDIDO CANCELADO/CONFIRMADO COMO ORÇAMENTO (EDITÁVEL)
        if (action === "reopen_sale_order") {
            const { order_id } = body;
            if (!order_id) {
                return res.status(400).json({ error: "ID do pedido é obrigatório." });
            }
            try {
                await execute("sale.order", "action_cancel", [[Number(order_id)]]);
            } catch (e) { /* já pode estar cancelado */ }
            await execute("sale.order", "action_draft", [[Number(order_id)]]);
            return res.status(200).json({ success: true });
        }

        // AÇÃO: CRIAR/ATUALIZAR PEDIDO DE VENDA (E, OPCIONALMENTE, CONFIRMAR + BAIXAR ESTOQUE + FATURAR)
        if (action === "save_sale_order") {
            const { order_id, partner_id, due_date, order_date, warehouse_id, lines, confirm, removed_line_ids } = body;

            if (!partner_id) return res.status(400).json({ error: "Selecione um cliente para o pedido." });
            const validLines = (lines || []).filter(l => l.product_id);
            if (validLines.length === 0) return res.status(400).json({ error: "Adicione ao menos um produto ao pedido." });

            let orderId = order_id ? Number(order_id) : null;

            const headerData = {
                partner_id: Number(partner_id),
                // "Condição de pagamento" fica sempre em branco no Odoo; o que vale é o vencimento
                payment_term_id: false,
                // O vencimento escolhido fica guardado no campo "Expiração" do pedido (validity_date)
                // até a fatura ser criada, quando ele é copiado para a "Data de vencimento" da fatura
                validity_date: due_date || false
            };
            if (warehouse_id) headerData.warehouse_id = Number(warehouse_id);
            // "Lançamento" = "Data do pedido" do Odoo (data e hora em UTC)
            if (order_date) headerData.date_order = order_date;

            if (!orderId) {
                headerData.order_line = validLines.map(l => [0, 0, {
                    product_id: Number(l.product_id),
                    product_uom_qty: Number(l.qty),
                    price_unit: Number(l.price),
                    discount: Number(l.discount) || 0
                }]);
                orderId = await execute("sale.order", "create", [headerData]);
            } else {
                // Uma única escrita no pedido (remove + atualiza + cria linhas), como o próprio Odoo faz
                const lineCommands = [];
                for (const rid of (removed_line_ids || [])) {
                    lineCommands.push([2, Number(rid), 0]);
                }
                for (const l of validLines) {
                    const lineVals = {
                        product_id: Number(l.product_id),
                        product_uom_qty: Number(l.qty),
                        price_unit: Number(l.price),
                        discount: Number(l.discount) || 0
                    };
                    lineCommands.push(l.id ? [1, Number(l.id), lineVals] : [0, 0, lineVals]);
                }
                if (lineCommands.length > 0) headerData.order_line = lineCommands;

                await execute("sale.order", "write", [[orderId], headerData]);
            }

            let warnings = [];
            let invoiceId = null;

            if (confirm) {
                try {
                    await execute("sale.order", "action_confirm", [[orderId]]);
                } catch (e) {
                    return res.status(200).json({ success: true, id: orderId, warnings: ["Pedido salvo, mas não foi possível confirmá-lo: " + e.message] });
                }

                // Tenta validar a(s) entrega(s) geradas, definindo a quantidade feita = quantidade pedida,
                // para baixar de fato o estoque do local/armazém escolhido
                try {
                    const pickings = await execute("stock.picking", "search_read", [[["sale_id", "=", orderId], ["state", "not in", ["done", "cancel"]]]], {
                        fields: ["id"]
                    });
                    for (const p of (pickings || [])) {
                        try {
                            const moves = await execute("stock.move", "search_read", [[["picking_id", "=", p.id]]], { fields: ["id", "product_uom_qty"] });
                            for (const mv of (moves || [])) {
                                try {
                                    await execute("stock.move", "write", [[mv.id], { quantity: mv.product_uom_qty }]);
                                } catch (e2) {
                                    await execute("stock.move", "write", [[mv.id], { quantity_done: mv.product_uom_qty }]).catch(() => {});
                                }
                            }
                            await execute("stock.picking", "button_validate", [[p.id]]);
                        } catch (e) {
                            warnings.push("Pedido confirmado, mas a entrega #" + p.id + " não pôde ser concluída automaticamente. Finalize-a no Odoo para baixar o estoque.");
                        }
                    }
                } catch (e) {
                    warnings.push("Não foi possível localizar a entrega gerada pelo pedido.");
                }

                // Deixa a entrega concluída e o pedido DESBLOQUEADOS (só travam quando a fatura for paga)
                try {
                    await definirBloqueioEntregas(orderId, false);
                } catch (e) {
                    warnings.push("Pedido confirmado, mas não foi possível deixar a entrega desbloqueada: " + e.message);
                }
                try {
                    await definirBloqueioPedido(orderId, false);
                } catch (e) {
                    warnings.push("Pedido confirmado, mas não foi possível deixar o pedido destravado: " + e.message);
                }

                // Gera a fatura em rascunho (equivalente a escolher "Fatura normal" e "Criar Rascunho" no Odoo).
                // A fatura NÃO é lançada automaticamente - isso é feito depois, na tela de revisão da fatura.
                try {
                    // garante que o pedido siga sem condição de pagamento (o Odoo pode preencher pelo cliente)
                    await execute("sale.order", "write", [[orderId], { payment_term_id: false }]).catch(() => {});
                    const invoiceIds = await criarFaturasDoPedido(orderId);
                    if (invoiceIds && invoiceIds.length > 0) {
                        invoiceId = invoiceIds[0];
                        await applyForcedAccountToInvoice(invoiceId);
                        try {
                            await aplicarVencimentoNaFatura(invoiceId, due_date);
                        } catch (e) {
                            warnings.push("Fatura criada, mas não foi possível definir a data de vencimento: " + e.message);
                        }
                    } else {
                        warnings.push("Pedido confirmado, mas ainda não havia nada a faturar. Use o botão \"Gerar Fatura\" no pedido depois de confirmar a entrega.");
                    }
                } catch (e) {
                    warnings.push("Pedido confirmado, mas não foi possível gerar a fatura automaticamente: " + e.message);
                }
            }

            return res.status(200).json({ success: true, id: orderId, invoice_id: invoiceId, warnings });
        }

        // AÇÃO: ALTERAR "LANÇAMENTO" (DATA DO PEDIDO) E VENCIMENTO DE UM PEDIDO, MESMO JÁ CONFIRMADO
        if (action === "update_sale_dates") {
            const { order_id, order_date, due_date } = body;
            if (!order_id) return res.status(400).json({ error: "ID do pedido é obrigatório." });
            const oid = Number(order_id);

            const vals = { validity_date: due_date || false };
            if (order_date) vals.date_order = order_date;
            try {
                await execute("sale.order", "write", [[oid], vals]);
            } catch (e) {
                return res.status(500).json({ error: "Não foi possível alterar as datas do pedido: " + e.message });
            }

            // O vencimento também vai para a(s) fatura(s) do pedido que não estejam canceladas
            const warnings = [];
            if (due_date) {
                try {
                    const ped = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
                    const ids = (ped && ped[0] && ped[0].invoice_ids) || [];
                    if (ids.length > 0) {
                        const faturas = await execute("account.move", "search_read", [[["id", "in", ids], ["state", "!=", "cancel"]]], { fields: ["id", "name"] });
                        for (const f of (faturas || [])) {
                            try {
                                await aplicarVencimentoNaFatura(f.id, due_date);
                            } catch (e) {
                                warnings.push("Datas do pedido salvas, mas não foi possível alterar o vencimento da fatura " + f.name + ": " + e.message);
                            }
                        }
                    }
                } catch (e) {
                    warnings.push("Datas do pedido salvas, mas não foi possível atualizar a fatura: " + e.message);
                }
            }
            return res.status(200).json({ success: true, warnings });
        }

        // AÇÃO: ALTERAR LINHAS (ADICIONAR / EXCLUIR / MUDAR QUANTIDADE) E DATAS DE UM PEDIDO JÁ CONFIRMADO
        if (action === "update_sale_lines") {
            const { order_id, lines, removed_line_ids, order_date, due_date } = body;
            if (!order_id) return res.status(400).json({ error: "ID do pedido é obrigatório." });
            const oid = Number(order_id);

            // linhas atuais do pedido: só escreve quantidade nas linhas que realmente mudaram
            const atuais = await execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], { fields: ["id", "product_uom_qty", "qty_delivered"] });
            const qtdAtual = {};
            const entregueAtual = {};
            (atuais || []).forEach(l => { qtdAtual[l.id] = l.product_uom_qty; entregueAtual[l.id] = Number(l.qty_delivered) || 0; });

            const cmds = [];
            for (const rid of (removed_line_ids || [])) {
                cmds.push([2, Number(rid), 0]);
            }
            for (const l of (lines || [])) {
                if (!l.product_id) continue;
                if (l.id) {
                    const nova = Number(l.qty);
                    if (qtdAtual[Number(l.id)] !== nova) cmds.push([1, Number(l.id), { product_uom_qty: nova }]);
                } else {
                    cmds.push([0, 0, {
                        product_id: Number(l.product_id),
                        product_uom_qty: Number(l.qty),
                        price_unit: Number(l.price),
                        discount: Number(l.discount) || 0
                    }]);
                }
            }

            // O Odoo não deixa reduzir/remover no pedido o que já foi entregue. Então, ANTES de alterar o pedido,
            // espelha a redução na entrega concluída (que é editável): a quantidade da entrega passa a ser a nova.
            const reducoes = []; // [id da linha, nova quantidade]
            for (const rid of (removed_line_ids || [])) {
                if ((entregueAtual[Number(rid)] || 0) > 0) reducoes.push([Number(rid), 0]);
            }
            for (const l of (lines || [])) {
                if (!l.product_id || !l.id) continue;
                const nova = Number(l.qty);
                if (nova < (entregueAtual[Number(l.id)] || 0)) reducoes.push([Number(l.id), nova]);
            }
            if (reducoes.length > 0) {
                try { await definirBloqueioEntregas(oid, false); } catch (e) { /* segue mesmo assim */ }
                const movs = await execute("stock.move", "search_read", [[
                    ["sale_line_id", "in", reducoes.map(r => r[0])], ["state", "=", "done"], ["picking_code", "=", "outgoing"]
                ]], { fields: ["id", "sale_line_id"] }).catch(async () => {
                    return await execute("stock.move", "search_read", [[["sale_line_id", "in", reducoes.map(r => r[0])], ["state", "=", "done"]]], { fields: ["id", "sale_line_id"] });
                });
                for (const [lid, nova] of reducoes) {
                    for (const mv of (movs || []).filter(m => Array.isArray(m.sale_line_id) && m.sale_line_id[0] === lid)) {
                        try {
                            try {
                                await execute("stock.move", "write", [[mv.id], { product_uom_qty: nova, quantity: nova }]);
                            } catch (e1) {
                                await execute("stock.move", "write", [[mv.id], { product_uom_qty: nova }]);
                                await execute("stock.move", "write", [[mv.id], { quantity: nova }]);
                            }
                        } catch (e) {
                            return res.status(400).json({ error: "Não foi possível reduzir a quantidade na entrega antes de alterar o pedido: " + e.message });
                        }
                    }
                }
            }

            const vals = { validity_date: due_date || false };
            if (order_date) vals.date_order = order_date;
            if (cmds.length > 0) vals.order_line = cmds;
            try {
                // "skip_procurement" pede ao Odoo para não criar entrega nova a cada ajuste
                await execute("sale.order", "write", [[oid], vals], { context: { skip_procurement: true } });
            } catch (e) {
                return res.status(400).json({ error: "Não foi possível alterar o pedido: " + e.message });
            }

            const warnings = [];

            // Mantém uma única entrega, igual ao pedido (produto e quantidade)
            if (cmds.length > 0) {
                try {
                    const avisosEntrega = await sincronizarEntregaComPedido(oid);
                    avisosEntrega.forEach(a => warnings.push(a));
                } catch (e) {
                    warnings.push("Pedido alterado, mas não foi possível ajustar a entrega: " + e.message);
                }
            }

            // Fatura provisória acompanha o pedido (a fatura só é lançada quando o pagamento for confirmado)
            if (cmds.length > 0) {
                try {
                    await sincronizarFaturaProvisoriaComPedido(oid);
                } catch (e) {
                    warnings.push("Pedido alterado, mas não foi possível atualizar a fatura provisória: " + e.message);
                }
            }

            // O vencimento também vai para a(s) fatura(s) do pedido que não estejam canceladas
            if (due_date) {
                try {
                    const ped = await execute("sale.order", "read", [[oid]], { fields: ["invoice_ids"] });
                    const ids = (ped && ped[0] && ped[0].invoice_ids) || [];
                    if (ids.length > 0) {
                        const faturas = await execute("account.move", "search_read", [[["id", "in", ids], ["state", "!=", "cancel"]]], { fields: ["id", "name"] });
                        for (const f of (faturas || [])) {
                            try {
                                await aplicarVencimentoNaFatura(f.id, due_date);
                            } catch (e) {
                                warnings.push("Não foi possível alterar o vencimento da fatura " + f.name + ": " + e.message);
                            }
                        }
                    }
                } catch (e) {
                    warnings.push("Não foi possível atualizar o vencimento da fatura: " + e.message);
                }
            }

            // Se mexeu nas linhas, avisa o que ainda não acompanha o pedido (entrega e fatura)
            if (cmds.length > 0) {
                try {
                    const depois = await execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], { fields: ["product_id", "product_uom_qty", "qty_delivered", "qty_invoiced"] });
                    const difEntrega = (depois || []).filter(l => Number(l.qty_delivered) !== Number(l.product_uom_qty));
                    const difFatura = (depois || []).filter(l => Number(l.qty_invoiced) !== Number(l.product_uom_qty));
                    if (difFatura.length > 0) {
                        warnings.push("A fatura ainda não acompanha estas linhas: " + difFatura.map(l => (Array.isArray(l.product_id) ? l.product_id[1] : "") + " (pedido " + l.product_uom_qty + ", faturado " + l.qty_invoiced + ")").join("; ") + ". Ajuste a fatura.");
                    }
                } catch (e) { /* aviso é só informativo */ }
            }

            return res.status(200).json({ success: true, warnings });
        }

        // AÇÃO: GERAR A FATURA (RASCUNHO) DE UM PEDIDO JÁ CONFIRMADO (CASO AINDA NÃO TENHA FATURA)
        if (action === "create_sale_invoice") {
            const { order_id } = body;
            if (!order_id) return res.status(400).json({ error: "ID do pedido é obrigatório." });

            try {
                const invoiceIds = await criarFaturasDoPedido(order_id);
                if (!invoiceIds || invoiceIds.length === 0) {
                    const diag = await diagnosticarPedidoSemFatura(order_id);
                    return res.status(400).json({ error: "Não foi possível gerar a fatura para este pedido." + diag });
                }
                await applyForcedAccountToInvoice(invoiceIds[0]);
                try {
                    const ped = await execute("sale.order", "read", [[Number(order_id)]], { fields: ["validity_date"] });
                    await aplicarVencimentoNaFatura(invoiceIds[0], ped && ped[0] && ped[0].validity_date);
                } catch (e) { /* o vencimento pode ser ajustado na fatura */ }
                return res.status(200).json({ success: true, invoice_id: invoiceIds[0] });
            } catch (e) {
                const diag = await diagnosticarPedidoSemFatura(order_id);
                return res.status(500).json({ error: "Erro ao gerar a fatura: " + e.message + diag });
            }
        }

        // AÇÃO: DETALHES DE UMA FATURA (TELA DE REVISÃO ANTES DE LANÇAR)
        if (action === "get_invoice_detail") {
            const { invoice_id } = body;
            if (!invoice_id) return res.status(400).json({ error: "ID da fatura é obrigatório." });

            const [invoices, lines] = await Promise.all([
                execute("account.move", "search_read", [[["id", "=", Number(invoice_id)]]], {
                    fields: ["id", "name", "partner_id", "invoice_payment_term_id", "invoice_date", "invoice_date_due", "state", "payment_state", "amount_total", "invoice_line_ids"]
                }),
                execute("account.move.line", "search_read", [[["move_id", "=", Number(invoice_id)], ["display_type", "=", "product"]]], {
                    fields: ["id", "product_id", "quantity", "discount", "price_unit", "price_subtotal", "price_total"]
                }).catch(() => [])
            ]);
            if (!invoices || invoices.length === 0) return res.status(404).json({ error: "Fatura não encontrada." });
            const invoice = invoices[0];

            return res.status(200).json({ invoice, lines: lines || [] });
        }

        // AÇÃO: ATUALIZAR DATA/DESCONTO DA FATURA (SOMENTE ENQUANTO ELA ESTIVER EM RASCUNHO)
        if (action === "update_invoice_detail") {
            const { invoice_id, invoice_date, due_date, lines } = body;
            if (!invoice_id) return res.status(400).json({ error: "ID da fatura é obrigatório." });

            const moveVals = {};
            if (invoice_date) moveVals.invoice_date = invoice_date;
            if (due_date) moveVals.invoice_date_due = due_date;
            const discountCommands = (lines || []).filter(l => l.id).map(l => [1, Number(l.id), { discount: Number(l.discount) || 0 }]);
            if (discountCommands.length > 0) moveVals.invoice_line_ids = discountCommands;
            if (Object.keys(moveVals).length > 0) {
                await execute("account.move", "write", [[Number(invoice_id)], moveVals]);
            }

            await applyForcedAccountToInvoice(Number(invoice_id));

            return res.status(200).json({ success: true });
        }

        // AÇÃO: LANÇAR (CONFIRMAR) A FATURA
        if (action === "post_sale_invoice") {
            const { invoice_id } = body;
            if (!invoice_id) return res.status(400).json({ error: "ID da fatura é obrigatório." });
            try {
                await execute("account.move", "action_post", [[Number(invoice_id)]]);
                return res.status(200).json({ success: true });
            } catch (e) {
                return res.status(500).json({ error: "Erro ao lançar a fatura: " + e.message });
            }
        }

        // AÇÃO: BUSCAR PARCEIROS
        if (action === "search_partners") {
            const query = body.query || "";
            const domain = query ? [["name", "ilike", query]] : [];
            const result = await execute("res.partner", "search_read", [domain], {
                fields: ["id", "name", "email", "phone"],
                limit: 20
            });
            return res.status(200).json({ partners: result || [] });
        }

        // AÇÃO: CRIAR PARCEIRO
        if (action === "create_partner") {
            const { name, email, phone } = body;
            if (!name || !name.trim()) {
                return res.status(400).json({ error: "Nome do parceiro é obrigatório." });
            }

            const newPartnerId = await execute("res.partner", "create", [{
                name: name.trim(),
                email: email ? email.trim() : false,
                phone: phone ? phone.trim() : false,
                customer_rank: 1
            }]);

            return res.status(200).json({ success: true, id: newPartnerId, name: name.trim() });
        }

        // AÇÃO: BUSCAR ESTOQUE
        if (action === "get_stock") {
            const query = body.query || "";
            // Somente "Locais internos" (igual ao filtro do Odoo); local opcional (inclui sublocais)
            const locationId = Number(body.location_id) || 0;
            const domain = [["quantity", ">", 0], ["location_id.usage", "=", "internal"]];
            if (locationId) domain.push(["location_id", "child_of", locationId]);
            if (query) domain.push(["product_id.name", "ilike", query]);

            const result = await execute("stock.quant", "search_read", [domain], {
                fields: ["id", "location_id", "product_id", "quantity"],
                limit: 100
            });
            return res.status(200).json({ result: result || [] });
        }

        // AÇÃO: BUSCAR PEDIDOS DE VENDAS
        if (action === "get_sales") {
            const query = body.query || "";
            const domain = [];
            if (query) {
                domain.push('|', ['name', 'ilike', query], ['partner_id.name', 'ilike', query]);
            }
            // Filtros: local/armazém e status (Orçamento = draft+sent, Confirmado = sale+done, Cancelado = cancel)
            if (body.warehouse_id) {
                domain.push(['warehouse_id', '=', parseInt(body.warehouse_id, 10)]);
            }
            const statusGroups = { draft: ['draft', 'sent'], sale: ['sale', 'done'], cancel: ['cancel'] };
            if (body.order_status && statusGroups[body.order_status]) {
                domain.push(['state', 'in', statusGroups[body.order_status]]);
            }

            const orders = await execute("sale.order", "search_read", [domain], {
                fields: ["id", "name", "partner_id", "amount_total", "state", "invoice_status", "invoice_ids", "warehouse_id", "date_order"],
                order: "id desc",
                limit: 100
            });

            // Busca em lote o status de pagamento das faturas ligadas a cada pedido
            const allInvoiceIds = [];
            (orders || []).forEach(o => (o.invoice_ids || []).forEach(id => allInvoiceIds.push(id)));

            let invoiceMap = {};
            if (allInvoiceIds.length > 0) {
                const invoices = await execute("account.move", "search_read", [[["id", "in", allInvoiceIds]]], {
                    fields: ["id", "payment_state", "state"]
                }).catch(() => []);
                (invoices || []).forEach(inv => { invoiceMap[inv.id] = inv; });
            }

            const result = (orders || []).map(o => {
                const invs = (o.invoice_ids || []).map(id => invoiceMap[id]).filter(Boolean);
                let paymentSummary = "nao_faturado";
                if (invs.length > 0) {
                    const allPaid = invs.every(i => i.payment_state === 'paid' || i.payment_state === 'in_payment');
                    paymentSummary = allPaid ? "pago" : "nao_pago";
                }
                return { ...o, payment_summary: paymentSummary };
            });

            return res.status(200).json({ result });
        }

        // AÇÃO: DETALHES DE UM PEDIDO DE VENDA
        if (action === "get_sale_detail") {
            const { order_id } = body;
            const oid = Number(order_id);

            // Tudo que não depende do resultado do pedido já sai em paralelo.
            // Listas de apoio vêm do cache; a lista de parceiros foi removida (o site não a usa aqui).
            const [orders, lines, paymentTerms, products, warehouses] = await Promise.all([
                execute("sale.order", "search_read", [[["id", "=", oid]]], {
                    fields: ["id", "name", "partner_id", "payment_term_id", "order_line", "state", "amount_total", "warehouse_id", "invoice_ids", "invoice_status", "validity_date", "date_order"]
                }),
                execute("sale.order.line", "search_read", [[["order_id", "=", oid], ["display_type", "=", false]]], {
                    fields: ["id", "product_id", "product_uom_qty", "price_unit", "discount", "price_subtotal"]
                }).catch(() => []),
                lookups.paymentTerms().catch(() => []),
                lookups.saleProducts().catch(() => []),
                lookups.warehouses().catch(() => [])
            ]);
            if (!orders || orders.length === 0) return res.status(404).json({ error: "Pedido de venda não encontrado." });

            const order = orders[0];
            const invoices = (order.invoice_ids && order.invoice_ids.length > 0)
                ? await execute("account.move", "search_read", [[["id", "in", order.invoice_ids]]], { fields: ["id", "name", "state", "payment_state", "amount_total", "invoice_date_due"] }).catch(() => [])
                : [];

            return res.status(200).json({ order, lines: lines || [], payment_terms: paymentTerms || [], products: products || [], warehouses: warehouses || [], invoices: invoices || [] });
        }

        // AÇÃO: BUSCAR LOCAIS DE ESTOQUE INTERNOS (PARA TRANSFERÊNCIAS)
        if (action === "get_locations") {
            const locations = await lookups.locations();
            return res.status(200).json({ result: (locations || []).slice().sort((a, b) => (a.complete_name || "").localeCompare(b.complete_name || "", "pt-BR")) });
        }

        // AÇÃO: PRODUTOS COM ESTOQUE EM UM LOCAL DE ORIGEM (para as linhas da transferência)
        if (action === "get_location_products") {
            const locId = Number(body.location_id) || 0;
            if (!locId) return res.status(400).json({ error: "Local de origem é obrigatório." });

            // estoque físico do local escolhido (e sublocais), somado por produto
            const quants = await execute("stock.quant", "search_read", [[
                ["location_id", "child_of", locId],
                ["location_id.usage", "=", "internal"],
                ["quantity", ">", 0]
            ]], { fields: ["product_id", "quantity"], limit: 10000 });

            const qtyByProduct = {};
            (quants || []).forEach(q => {
                if (!Array.isArray(q.product_id)) return;
                qtyByProduct[q.product_id[0]] = (qtyByProduct[q.product_id[0]] || 0) + q.quantity;
            });
            const ids = Object.keys(qtyByProduct).map(Number);
            if (ids.length === 0) return res.status(200).json({ products: [] });

            // sem ordenar por display_name aqui (campo calculado, o Odoo rejeita); a ordem é feita no servidor
            const products = await execute("product.product", "search_read", [[["id", "in", ids], ["type", "!=", "service"]]], {
                fields: ["id", "display_name", "uom_id"]
            });
            const list = (products || [])
                .map(pr => ({ ...pr, stock_qty: qtyByProduct[pr.id] }))
                .sort((a, b) => (a.display_name || "").localeCompare(b.display_name || "", "pt-BR"));
            return res.status(200).json({ products: list });
        }

        // AÇÃO: DADOS PARA A TRANSFERÊNCIA ENTRE CONTAS (contas de caixa/banco + diário "Transferências")
        if (action === "get_account_transfer_setup") {
            const accounts = await getCashBankAccounts();
            const journal = await getTransferJournal();
            return res.status(200).json({
                accounts: accounts.map(a => ({ id: a.id, code: a.code || "", name: a.name || "" })),
                journal: journal ? { id: journal.id, name: journal.name } : null
            });
        }

        // AÇÃO: LANÇAR TRANSFERÊNCIA ENTRE CONTAS (lançamento de diário no diário "Transferências")
        if (action === "create_account_transfer") {
            const fromId = Number(body.from_account_id) || 0;
            const toId = Number(body.to_account_id) || 0;
            const amount = Math.round(Number(body.amount) * 100) / 100;

            if (!fromId || !toId) return res.status(400).json({ error: "Selecione a conta de origem e a conta de destino." });
            if (fromId === toId) return res.status(400).json({ error: "A conta de origem e a de destino devem ser diferentes." });
            if (!(amount > 0)) return res.status(400).json({ error: "Informe um valor maior que zero." });

            // só aceita contas de caixa/banco
            const allowed = (await getCashBankAccounts()).map(a => a.id);
            if (!allowed.includes(fromId) || !allowed.includes(toId)) {
                return res.status(400).json({ error: "Conta inválida para transferência." });
            }

            const journal = await getTransferJournal();
            if (!journal) return res.status(400).json({ error: 'Diário "Transferências" não encontrado no Odoo.' });

            // data automática (a do painel, que usa o fuso do usuário); se fugir de ±1 dia do servidor, usa a do servidor
            const serverToday = new Date().toISOString().slice(0, 10);
            let entryDate = serverToday;
            if (/^\d{4}-\d{2}-\d{2}$/.test(body.date || "")) {
                const diffDays = Math.abs(new Date(body.date + "T00:00:00Z") - new Date(serverToday + "T00:00:00Z")) / 86400000;
                if (diffDays <= 1) entryDate = body.date;
            }

            // 1ª linha: conta que RECEBE (débito); 2ª linha: conta de ONDE SAI (crédito)
            const moveId = await execute("account.move", "create", [{
                move_type: "entry",
                journal_id: journal.id,
                date: entryDate,
                line_ids: [
                    [0, 0, { account_id: toId, debit: amount, credit: 0 }],
                    [0, 0, { account_id: fromId, debit: 0, credit: amount }]
                ]
            }]);

            try {
                await execute("account.move", "action_post", [[moveId]]);
            } catch (e) {
                // não deixa um lançamento provisório órfão no Odoo
                await execute("account.move", "unlink", [[moveId]]).catch(() => {});
                throw e;
            }

            const moves = await execute("account.move", "read", [[moveId]], { fields: ["name"] }).catch(() => []);
            return res.status(200).json({ success: true, id: moveId, name: (moves && moves[0] && moves[0].name) || "" });
        }

        // AÇÃO: BUSCAR TRANSFERÊNCIAS INTERNAS
        if (action === "get_transfers") {
            const query = body.query || "";
            const domain = [["picking_type_id.code", "=", "internal"]];
            if (query) domain.push(["name", "ilike", query]);
            // filtros: origem, destino (incluem sublocais) e período da data efetiva (já em UTC, vindo do painel)
            if (Number(body.origin_id)) domain.push(["location_id", "child_of", Number(body.origin_id)]);
            if (Number(body.dest_id)) domain.push(["location_dest_id", "child_of", Number(body.dest_id)]);
            if (body.date_from) domain.push(["date_done", ">=", body.date_from]);
            if (body.date_to) domain.push(["date_done", "<=", body.date_to]);

            const result = await execute("stock.picking", "search_read", [domain], {
                fields: ["id", "name", "location_id", "location_dest_id", "state", "date_done"],
                order: "id desc",
                limit: 100
            });
            return res.status(200).json({ result: result || [] });
        }

        // AÇÃO: DETALHES DE UMA TRANSFERÊNCIA
        if (action === "get_transfer_detail") {
            const { order_id } = body;
            const [pickings, moves, locations, products] = await Promise.all([
                execute("stock.picking", "search_read", [[["id", "=", order_id]]], {
                    fields: ["id", "name", "location_id", "location_dest_id", "state", "picking_type_id"]
                }),
                execute("stock.move", "search_read", [[["picking_id", "=", order_id]]], {
                    fields: ["id", "product_id", "product_uom_qty"]
                }),
                lookups.locations(),
                lookups.transferProducts()
            ]);
            if (!pickings || pickings.length === 0) return res.status(404).json({ error: "Transferência não encontrada." });

            const picking = pickings[0];
            return res.status(200).json({ order: picking, lines: moves || [], locations: locations || [], products: products || [] });
        }

        // AÇÃO: CRIAR NOVA TRANSFERÊNCIA INTERNA
        if (action === "create_transfer") {
            const defaultType = await resolveInternalPickingType(null);
            if (!defaultType) {
                return res.status(400).json({ error: "Nenhum tipo de operação de Transferência Interna encontrado no Odoo." });
            }

            const newPickingId = await execute("stock.picking", "create", [{
                picking_type_id: defaultType.id,
                location_id: Array.isArray(defaultType.default_location_src_id) ? defaultType.default_location_src_id[0] : false,
                location_dest_id: Array.isArray(defaultType.default_location_dest_id) ? defaultType.default_location_dest_id[0] : false
            }]);

            return res.status(200).json({ success: true, id: newPickingId });
        }

        // AÇÃO: EXCLUIR TRANSFERÊNCIA (APENAS PERMITIDO EM RASCUNHO PELO PRÓPRIO ODOO)
        if (action === "delete_transfer") {
            const { order_id } = body;
            if (!order_id) return res.status(400).json({ error: "ID da transferência é obrigatório." });
            await execute("stock.picking", "unlink", [[Number(order_id)]]);
            return res.status(200).json({ success: true });
        }

        // AÇÃO: ATUALIZAR LOCAIS/ITENS DA TRANSFERÊNCIA E, OPCIONALMENTE, VALIDAR
        if (action === "update_transfer") {
            const { order_id, location_id, location_dest_id, lines, validate } = body;
            if (!order_id) return res.status(400).json({ error: "ID da transferência é obrigatório." });

            const writeData = {};
            if (location_id) writeData.location_id = Number(location_id);
            if (location_dest_id) writeData.location_dest_id = Number(location_dest_id);

            if (location_id) {
                const matchedType = await resolveInternalPickingType(location_id);
                if (matchedType) writeData.picking_type_id = matchedType.id;
            }

            const moveLocUpdate = {};
            if (writeData.location_id) moveLocUpdate.location_id = writeData.location_id;
            if (writeData.location_dest_id) moveLocUpdate.location_dest_id = writeData.location_dest_id;

            // Itens: atualizar/criar tudo na mesma escrita do picking
            for (const l of (lines || [])) {
                if (l.product_id && !(Number(l.qty) > 0)) {
                    return res.status(400).json({ error: "A demanda de cada item deve ser maior que zero." });
                }
            }

            const moveCommands = [];
            for (const l of (lines || [])) {
                if (l.id && !l.product_id) {
                    if (Object.keys(moveLocUpdate).length > 0) moveCommands.push([1, Number(l.id), { ...moveLocUpdate }]);
                    continue;
                }
                if (!l.product_id) continue;

                if (l.id) {
                    moveCommands.push([1, Number(l.id), await onlyExistingFields("stock.move", {
                        product_id: Number(l.product_id),
                        product_uom_qty: Number(l.qty),
                        ...moveLocUpdate
                    })]);
                } else {
                    // OBS: stock.move não tem o campo "name" no Odoo 18 (causava "Invalid field 'name' in 'stock.move'")
                    const newMove = {
                        product_id: Number(l.product_id),
                        product_uom_qty: Number(l.qty),
                        location_id: writeData.location_id || (location_id ? Number(location_id) : undefined),
                        location_dest_id: writeData.location_dest_id || (location_dest_id ? Number(location_dest_id) : undefined)
                    };
                    // a unidade de medida (product_uom) o Odoo define sozinho a partir do produto
                    moveCommands.push([0, 0, await onlyExistingFields("stock.move", newMove)]);
                }
            }
            if (moveCommands.length > 0) writeData.move_ids = moveCommands;

            if (Object.keys(writeData).length > 0) {
                await execute("stock.picking", "write", [[Number(order_id)], writeData]);
            }

            if (validate) {
                await execute("stock.picking", "button_validate", [[Number(order_id)]]);
            }

            return res.status(200).json({ success: true });
        }

        // AÇÃO: CATEGORIAS DA TELA DE PRODUTOS (só as que têm produtos "Mercadorias" + "Vendas")
        // AÇÃO: TODAS AS CATEGORIAS DE PRODUTO (para trocar a categoria no pop-up de edição)
        if (action === "get_all_product_categories") {
            const allCats = await cached("all_product_categories", TTL_LONG, () =>
                execute("product.category", "search_read", [[]], { fields: ["id", "complete_name"], limit: 500 })
            );
            const list = (allCats || [])
                .map(c => ({ id: c.id, name: c.complete_name }))
                .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
            return res.status(200).json({ result: list });
        }

        if (action === "get_product_categories") {
            const cats = await cached("product_categories", TTL_PRODUCTS, async () => {
                try {
                    const groups = await execute("product.template", "read_group", [PRODUCT_BASE_DOMAIN], {
                        groupby: ["categ_id"],
                        fields: ["categ_id"],
                        lazy: false
                    });
                    return (groups || [])
                        .filter(g => Array.isArray(g.categ_id))
                        .map(g => ({ id: g.categ_id[0], name: g.categ_id[1], count: g.__count ?? g.categ_id_count ?? 0 }));
                } catch (e) {
                    // reserva: lê só a categoria de cada produto e conta aqui mesmo
                    const rows = await execute("product.template", "search_read", [PRODUCT_BASE_DOMAIN], { fields: ["categ_id"] });
                    const map = {};
                    (rows || []).forEach(r => {
                        if (!Array.isArray(r.categ_id)) return;
                        const k = r.categ_id[0];
                        map[k] = map[k] || { id: k, name: r.categ_id[1], count: 0 };
                        map[k].count++;
                    });
                    return Object.values(map);
                }
            });
            cats.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
            return res.status(200).json({ result: cats });
        }

        // AÇÃO PADRÃO: PRODUTOS (apenas tipo "Mercadorias" com "Vendas" marcado; categoria opcional)
        const query = body.query || "";
        const categoryId = Number(body.category_id) || 0;
        const domain = [...PRODUCT_BASE_DOMAIN];
        if (categoryId) domain.push(["categ_id", "child_of", categoryId]);
        if (query) domain.push(["name", "ilike", query]);
        const result = await execute("product.template", "search_read", [domain], {
            fields: ["id", "name", "list_price", "standard_price", "qty_available", "type", "categ_id"],
            order: "name asc",
            limit: 100
        });

        return res.status(200).json({ result: result || [] });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
