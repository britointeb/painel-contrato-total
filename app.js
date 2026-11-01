/*
 * Organização do JavaScript — as definições são carregadas antes do primeiro render.
 * 1. Dados: normalização, leitura de colunas e índices de relacionamento.
 * 2. Negócio: vigência, saldos canônicos, classificações e resumo autorizado.
 * 3. Apresentação: cores, tooltips, plugins, formatação e links seguros.
 * 4. Exportação e componentes reutilizáveis.
 * 5. Documentos contábeis, navegação, painel de contratos e autenticação.
 * A autorização e o consumo de cota permanecem no Code.gs.
 */
// 1. DADOS — conversões compartilhadas e índices recalculados por carga.
const UnifiedData = (() => {
  const brlFormatter = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const percentFormatter = new Intl.NumberFormat('pt-BR', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const normalize = value => String(value == null ? '' : value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  const key = value => normalize(value).replace(/[^A-Z0-9]/g, '');
  const number = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    let text = String(value == null ? '' : value).trim();
    const negative = /^\(.*\)$/.test(text) || /[-−]/.test(text);
    const numericText = text.replace(/R\$|[\s()%]/gi, '');
    if (!/^[+−-]?[\d.,]+[−-]?$/.test(numericText)) return 0;
    text = text.replace(/[^\d.,]/g, '');
    if (!text) return 0;
    if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '');
    const result = Number(text);
    return Number.isFinite(result) ? negative ? -result : result : 0;
  };
  const date = value => {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const text = String(value == null ? '' : value).trim();
    let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/);
    let year, month, day;
    if (match) [, day, month, year] = match.map(Number);else {
      match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
      if (!match) return null;
      [, year, month, day] = match.map(Number);
    }
    const result = new Date(year, month - 1, day);
    return result.getFullYear() === year && result.getMonth() === month - 1 && result.getDate() === day ? result : null;
  };
  const brl = value => brlFormatter.format(Number.isFinite(value) ? Object.is(value, -0) ? 0 : value : 0);
  const percent = value => percentFormatter.format(Number.isFinite(value) ? Object.is(value, -0) ? 0 : value : 0);
  const percentNumber = value => typeof value === 'string' && value.includes('%') ? number(value) / 100 : number(value);
  const split = value => [...new Set(normalize(value).split(/\s*;\s*/).filter(v => v && v !== '-' && v !== 'N/I'))];
  const documentId = row => [key(row.ug), key(row.documento)].join('|');
  const ndParts = detail => {
    const codes = String(detail.nd_codigo || '').split(/\s*;\s*/);
    const names = String(detail.nd_nome || '').split(/\s*;\s*/).map(normalize);
    const records = new Map();
    codes.forEach((rawCode, index) => {
      const code = String(rawCode).replace(/\D/g, '');
      if (code.length < 6 || code.length > 8) return;
      const name = names[index] || (names.length === 1 ? names[0] : '') || 'N/I';
      const subelemento = code.length === 8 ? code.slice(6, 8) : '';
      const part = {
        code,
        name,
        grupo: code.slice(1, 2),
        modalidade: code.slice(2, 4),
        elemento: code.slice(4, 6),
        subelemento,
        subelemento_filter: subelemento ? `${subelemento} – ${name}` : ''
      };
      if (!records.has(code) || records.get(code).name === 'N/I') records.set(code, part);
    });
    return [...records.values()];
  };
  const ndDimensionValues = function (detail) {
    let parts = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : ndParts(detail);
    const values = field => [...new Set(parts.map(part => part[field]).filter(Boolean))];
    return {
      nd_grupo_values: values('grupo'),
      nd_modalidade_values: values('modalidade'),
      nd_elemento_values: values('elemento'),
      nd_subelemento_filter_values: values('subelemento_filter')
    };
  };
  const ndBudgetFields = {
    fGrupo: 'grupo',
    fNdModalidade: 'modalidade',
    fElemento: 'elemento',
    fSubelemento: 'subelemento_filter'
  };
  const budgetDetailPortions = (detail, filters) => {
    const parts = ndParts(detail);
    if (parts.length < 2) return matchesBudgetDetail(detail, filters) ? [detail] : [];
    const metricKeys = ['v_empenhado', 'v_recebido', 'v_liquidado', 'v_pago', 'v_cancelado', 'v_bloqueado', 'v_a_liquidar', 'v_a_pagar', 'v_executado'];
    return parts.map(part => {
      const portion = {
        ...detail,
        nd_codigo: part.code,
        nd_nome: part.name,
        nd_filter_values: [part.name && part.name !== 'N/I' ? `${part.name} – ${part.code}` : part.code]
      };
      metricKeys.forEach(field => {
        portion[field] = (detail[field] || 0) / parts.length;
      });
      return portion;
    }).filter(portion => matchesBudgetDetail(portion, filters));
  };
  const aggregateCommitments = rows => {
    const groups = new Map();
    rows.forEach(row => {
      if (!row.empenho || row.empenho === '-' || !key(row.empenho)) return;
      const identity = [key(row.contrato), key(row.ug), key(row.empenho)].join('|');
      if (!groups.has(identity)) groups.set(identity, {
        identity,
        label: `${row.empenho} | ${row.contrato || 'S/ CONTRATO'} | UG ${row.ug || 'N/I'}`,
        contrato: row.contrato || '-',
        empenho: row.empenho,
        ug: row.ug || '-',
        fornecedor: row.favorecido || '-',
        portal_contexts: [],
        contracts: new Set(),
        descriptions: new Set(),
        global: 0,
        total: 0,
        recebido: 0,
        liquidado: 0,
        pago: 0,
        bloqueado: 0,
        cancelado: 0
      });
      const group = groups.get(identity);
      if (row.contrato && row.contrato !== '-') group.contracts.add(key(row.contrato));
      const commitmentContexts = Object.prototype.hasOwnProperty.call(row, "portal_contexts") ? Array.isArray(row.portal_contexts) && row.portal_contexts.length ? row.portal_contexts : [{}] : [{
        ug: row.portal_ug ?? row.ug,
        gestao: row.gestao
      }];
      commitmentContexts.forEach(context => {
        if (!group.portal_contexts.some(item => item.ug === context.ug && item.gestao === context.gestao)) group.portal_contexts.push({
          ...context
        });
      });
      group.descriptions.add(`Empenho: ${row.empenho} | Contrato: ${row.contrato || '-'} | Emitente: ${row.ug || '-'} | Favorecido: ${row.favorecido || '-'}`);
      group.total += number(row.v_empenhado);
      group.recebido += number(row.v_recebido);
      group.liquidado += number(row.v_liquidado);
      group.pago += number(row.v_pago);
      group.bloqueado += number(row.v_bloqueado);
      group.cancelado += number(row.v_cancelado);
    });
    return [...groups.values()].map(group => ({
      ...group,
      a_liquidar: group.total - group.liquidado - group.bloqueado - group.cancelado,
      a_pagar: group.total - group.pago - group.bloqueado - group.cancelado,
      executado: group.liquidado + group.bloqueado + group.cancelado
    }));
  };
  const budgetFields = {
    fAo: 'ao_filter',
    fPo: 'po_filter',
    fPi: 'pi_filter',
    fNd: 'nd_filter_values',
    fAoCodigo: 'ao_codigo',
    fAoNome: 'ao_nome',
    fPoCodigo: 'po_codigo',
    fPoNome: 'po_nome',
    fPtres: 'ptres',
    fPiCod: 'pi_codigo',
    fPiNome: 'pi_nome',
    fNdCodigo: 'nd_codigo',
    fNdNome: 'nd_nome'
  };
  const hasBudgetFilters = filters => [...Object.keys(budgetFields), ...Object.keys(ndBudgetFields)].some(field => (filters[field] || []).length);
  const matchesBudgetDetail = (detail, filters) => {
    const scalarMatches = Object.entries(budgetFields).every(_ref => {
      let [field, property] = _ref;
      const selected = filters[field] || [];
      if (!selected.length) return true;
      const values = Array.isArray(detail[property]) ? detail[property] : split(detail[property]);
      return selected.some(value => values.includes(normalize(value)));
    });
    if (!scalarMatches) return false;
    if (!Object.keys(ndBudgetFields).some(field => (filters[field] || []).length)) return true;
    return ndParts(detail).some(part => Object.entries(ndBudgetFields).every(_ref2 => {
      let [field, property] = _ref2;
      return !(filters[field] || []).length || filters[field].some(value => normalize(value) === part[property]);
    }));
  };
  // Compile aliases once per loaded header. Resolution preserves the first
  // exact header, alias order and first fuzzy match used by the V5 reader.
  const compileReaders = function (headers, schema) {
    let normalizer = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : normalize;
    const normalizedHeaders = headers.map(normalizer),
      exact = new Map();
    normalizedHeaders.forEach((header, index) => {
      if (!exact.has(header)) exact.set(header, index);
    });
    return Object.fromEntries(Object.entries(schema).map(_ref3 => {
      let [field, spec] = _ref3;
      let index = -1;
      for (const name of spec.names) {
        const alias = normalizer(name);
        if (exact.has(alias)) {
          index = exact.get(alias);
          break;
        }
      }
      if (index < 0) for (const name of spec.fallbacks || []) {
        const alias = normalizer(name);
        index = normalizedHeaders.findIndex(header => header.includes(alias));
        if (index >= 0) break;
      }
      return [field, row => index < 0 ? '' : normalizer(row[index])];
    }));
  };
  // Keep exact source keys first. The canonical fallback keeps the first
  // matching object entry, as the previous Object.entries(...).find did.
  const contractLookup = function (records) {
    let normalizer = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : key;
    const canonical = new Map();
    Object.entries(records).forEach(_ref4 => {
      let [contract, value] = _ref4;
      const id = normalizer(contract);
      if (!canonical.has(id)) canonical.set(id, value);
    });
    return contract => records[contract] || canonical.get(normalizer(contract));
  };
  const budgetIndex = rows => {
    const byContract = new Map(),
      byCommitment = new Map();
    if (!rows || rows.length < 2) return {
      byContract,
      byCommitment
    };
    const read = compileReaders(rows[0], {
      contract: {
        names: ['COL_NR_CONTR_BASE', 'Contrato', 'Número Contrato', 'Numero Contrato'],
        fallbacks: ['contr base', 'contrato']
      },
      commitment: {
        names: ['Documento CCor Número', 'Documento CCor Numero', 'DOCUMENTO_CCOR_NUMERO'],
        fallbacks: ['documento ccor']
      },
      ao_codigo: {
        names: ['Ação Governo Código', 'AO Código', 'AO Codigo']
      },
      ao_nome: {
        names: ['Ação Governo Nome', 'AO Nome']
      },
      po_codigo: {
        names: ['Plano Orçamentário Código PO', 'PO Código', 'PO Codigo']
      },
      po_nome: {
        names: ['Plano Orçamentário Nome', 'PO Nome']
      },
      pi_codigo: {
        names: ['PI Código PI', 'PI Código', 'PI Codigo']
      },
      pi_nome: {
        names: ['PI Nome']
      },
      nd_codigo: {
        names: ['ND_DOC', 'ND Código', 'ND Codigo']
      },
      nd_nome: {
        names: ['ND_NOME', 'ND Nome']
      },
      ug: {
        names: ['Emitente - UG Código', 'Emitente - UG Codigo', 'UG Emitente', 'UG Código', 'UG Codigo']
      },
      ptres: {
        names: ['PTRES Código', 'PTRES Codigo', 'PTRES']
      }
    });
    const pair = (name, code) => name && name !== 'N/I' && name !== '-' ? `${name} – ${code || 'N/I'}` : code;
    rows.slice(1).forEach(row => {
      const contract = key(read.contract(row));
      const commitment = key(read.commitment(row));
      if (!contract) return;
      const detail = {
        ao_codigo: read.ao_codigo(row),
        ao_nome: read.ao_nome(row),
        po_codigo: read.po_codigo(row),
        po_nome: read.po_nome(row),
        pi_codigo: read.pi_codigo(row),
        pi_nome: read.pi_nome(row),
        nd_codigo: read.nd_codigo(row),
        nd_nome: read.nd_nome(row),
        ug: read.ug(row),
        ptres: read.ptres(row)
      };
      detail.ao_filter = detail.ao_nome && detail.ao_nome !== 'N/I' && detail.ao_nome !== '-' ? `${detail.ao_codigo || 'N/I'} – ${detail.ao_nome}` : detail.ao_codigo;
      detail.po_filter = detail.po_nome && detail.po_nome !== 'N/I' && detail.po_nome !== '-' ? `${detail.po_codigo || 'N/I'} – ${detail.po_nome}` : detail.po_codigo;
      detail.pi_filter = pair(detail.pi_nome, detail.pi_codigo);
      const parts = ndParts(detail);
      detail.nd_filter_values = parts.map(part => pair(part.name, part.code));
      Object.assign(detail, ndDimensionValues(detail, parts));
      if (!byContract.has(contract)) byContract.set(contract, []);
      byContract.get(contract).push(detail);
      if (commitment) {
        const id = `${contract}|${commitment}`;
        if (!byCommitment.has(id)) byCommitment.set(id, []);
        byCommitment.get(id).push(detail);
      }
    });
    return {
      byContract,
      byCommitment
    };
  };
  const matchesBudgetRow = (row, filters, index) => {
    if (!hasBudgetFilters(filters)) return true;
    const contract = key(row.contrato);
    const candidates = row.existencia === 'GERAL' ? index.byContract.get(contract) : index.byCommitment.get(`${contract}|${key(row.empenho)}`);
    return !!candidates && candidates.some(detail => (!detail.ug || !row.ug || key(detail.ug) === key(row.ug)) && matchesBudgetDetail(detail, filters));
  };
  const attachReceived = (details, received) => {
    const groups = new Map();
    details.forEach(detail => {
      const id = `${key(detail.contrato)}|${key(detail.documento)}`;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(detail);
    });
    groups.forEach((items, id) => {
      const total = received[id] || 0;
      // The source has no allocation rule for a commitment with more than
      // one classification. Keep its receipt in contract totals, disclose
      // it separately, and never invent an attribution or multiply it.
      items.forEach(detail => {
        detail.v_recebido = items.length === 1 ? total : 0;
        detail.recebido_sem_classificacao = items.length > 1 ? total : 0;
      });
    });
  };
  return {
    number,
    date,
    key,
    normalize,
    brl,
    percent,
    percentNumber,
    documentId,
    budgetIndex,
    matchesBudgetDetail,
    matchesBudgetRow,
    hasBudgetFilters,
    attachReceived,
    ndParts,
    ndDimensionValues,
    budgetDetailPortions,
    aggregateCommitments,
    compileReaders,
    contractLookup
  };
})();

// 2. REGRAS DE NEGÓCIO — somas por contrato, metadata da primeira linha e situações exclusivas.
/* Authorized file URLs are read only from the first canonical Geral record. */
const ContractFiles = (() => {
  const fields = Object.freeze([Object.freeze({
    key: 'diarios',
    column: 'LINK_DIARIO',
    label: 'DIÁRIOS'
  }), Object.freeze({
    key: 'docs',
    column: 'LINK_DOC_EXEC',
    label: 'DOCS'
  }), Object.freeze({
    key: 'relatorio',
    column: 'LINK_REL_ACOMP',
    label: 'RELATÓRIO'
  }), Object.freeze({
    key: 'dados',
    column: 'LINK_DADOS_CONTR',
    label: 'DADOS'
  })]);
  const empty = Object.freeze(Object.fromEntries(fields.map(field => [field.key, ''])));
  const safeUrl = value => {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!/^https?:\/\//i.test(raw) || /[\u0000-\u0020\u007f\\]/.test(raw)) return '';
    try {
      const url = new URL(raw);
      const host = url.hostname.replace(/\.$/, '');
      const validHost = /^\[[0-9a-f:.]+\]$/i.test(host) || host && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
      return ['https:', 'http:'].includes(url.protocol) && validHost && !url.username && !url.password ? raw : '';
    } catch (_) {
      return '';
    }
  };
  const index = rows => {
    const result = new Map();
    if (!Array.isArray(rows) || rows.length < 2) return result;
    const headers = (rows[0] || []).map(UnifiedData.key);
    const contractColumn = ['Número Contrato', 'Numero Contrato', 'Nº Contrato', 'N Contrato', 'Contrato', 'COL_NR_CONTR_BASE', 'numero_contrato'].map(UnifiedData.key).map(key => headers.indexOf(key)).find(index => index >= 0);
    if (contractColumn === undefined) return result;
    const columns = fields.map(field => headers.indexOf(UnifiedData.key(field.column)));
    rows.slice(1).forEach(row => {
      const rawContract = row === null || row === void 0 ? void 0 : row[contractColumn],
        id = UnifiedData.key(rawContract);
      if (!id || ['N/I', 'N/A'].includes(UnifiedData.normalize(rawContract)) || result.has(id)) return;
      result.set(id, Object.freeze(Object.fromEntries(fields.map((field, i) => [field.key, safeUrl(columns[i] < 0 ? '' : row[columns[i]])]))));
    });
    return result;
  };
  const get = (row, key) => {
    var _row$files;
    return safeUrl(row === null || row === void 0 || (_row$files = row.files) === null || _row$files === void 0 ? void 0 : _row$files[key]);
  };
  const missingColumns = rows => {
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) return [];
    const headers = new Set(rows[0].map(UnifiedData.key));
    return fields.filter(field => !headers.has(UnifiedData.key(field.column))).map(field => field.column);
  };
  const exportColumns = () => fields.map(field => ({
    header: `${field.label} (URL)`,
    key: `files_${field.key}`,
    format: row => get(row, field.key)
  }));
  return Object.freeze({
    fields,
    empty,
    safeUrl,
    index,
    get,
    missingColumns,
    exportColumns
  });
})();
const ContractRules = (() => {
  const cents = value => Math.round(UnifiedData.number(value) * 100);
  const metrics = ['v_empenhado', 'v_recebido', 'v_liquidado', 'v_pago', 'v_cancelado', 'v_bloqueado'];
  const priority = ['VIG EXEC TOTAL', 'VIG EXEC PARCIAL', 'VIG EM EXEC', 'VIG SEM EXEC', 'VENC INEXEC TOTAL', 'VENC EXEC TOTAL', 'VENC EXEC PARCIAL'];
  const primaryFlag = flags => priority.map(label => (flags || []).find(flag => flag.label === label)).find(Boolean) || (flags === null || flags === void 0 ? void 0 : flags[0]);
  const midnight = value => {
    const parsed = typeof value === 'number' ? value > 0 ? new Date(value) : null : UnifiedData.date(value);
    return parsed && Number.isFinite(parsed.getTime()) ? new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime() : null;
  };
  const todayTime = now => midnight(now || new Date());
  const phase = function (metadata) {
    let now = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : new Date();
    metadata = metadata.contract_metadata || metadata;
    const today = todayTime(now);
    const start = midnight(metadata.dtInicVal || metadata.data_inic);
    const end = midnight(metadata.dtFimVal || metadata.data_fim);
    if (end !== null && end < today) return 'vencido';
    if (start !== null && end !== null && start <= today && end >= today) return 'vigente';
    if (start !== null && start > today) return 'futuro';
    return 'sem-data';
  };
  const classify = function (totals) {
    let metadata = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : totals;
    let documentMovement = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
    let now = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : new Date();
    const labels = [];
    const values = Object.fromEntries(metrics.map(field => [field, cents(totals[field])]));
    const movement = documentMovement || Object.values(values).some(value => value !== 0);
    if (values.v_cancelado > 0) labels.push('CAN');
    if (values.v_bloqueado > 0) labels.push('BLOQ');
    const state = phase(metadata, now);
    let execution = null;
    // Specific outcomes precede the broader ongoing/no-receipt conditions.
    // Only CAN and BLOQ are independent decorations of the execution status.
    if (state === 'vigente') {
      if (movement && values.v_empenhado === values.v_pago) execution = 'VIG EXEC TOTAL';else if (values.v_cancelado > 0 && values.v_empenhado === values.v_pago + values.v_cancelado) execution = 'VIG EXEC PARCIAL';else if (values.v_recebido > 0 && values.v_pago !== values.v_empenhado) execution = 'VIG EM EXEC';else if (values.v_recebido === 0) execution = 'VIG SEM EXEC';
    } else if (state === 'vencido') {
      if (values.v_pago === 0) execution = 'VENC INEXEC TOTAL';else if (values.v_empenhado === values.v_pago) execution = 'VENC EXEC TOTAL';else if (values.v_pago < values.v_empenhado) execution = 'VENC EXEC PARCIAL';
    }
    if (execution) labels.push(execution);
    return {
      labels,
      state,
      primary: execution || labels[0] || 'N/I'
    };
  };
  const contractIndex = rows => {
    const index = new Map();
    const metadataFields = ['data_inic', 'data_fim', 'dtInicVal', 'dtFimVal', 'dias_passaram', 'perc_tempo', 'encerrando_dias', 'duracao_total_dias', 'ano_vig_ini', 'sec_log', 'fornecedor', 'fiscal', 'gestor', 'fiscal_sub', 'gestor_sub', 'modalidade', 'compra', 'objeto', 'v_global'];
    const financialFields = [...metrics, 'v_executado', 'v_a_liquidar', 'v_a_pagar'];
    const comparable = (field, value) => field === 'v_global' ? cents(value) : field.startsWith('dt') ? value || null : UnifiedData.normalize(value);
    (rows || []).forEach(row => {
      const id = UnifiedData.key(row.contrato);
      if (!id || row.contrato === '-') return;
      const metadata = row.contract_metadata || Object.fromEntries(metadataFields.map(field => [field, row[field]]));
      if (!index.has(id)) index.set(id, {
        metadata: {
          ...metadata
        },
        totals: Object.fromEntries(financialFields.map(field => [field, 0])),
        conflicts: new Set()
      });
      const entry = index.get(id);
      metadataFields.forEach(field => {
        if (comparable(field, metadata[field]) !== comparable(field, entry.metadata[field])) entry.conflicts.add(field);
      });
      (row.contract_metadata_conflicts || []).forEach(field => entry.conflicts.add(field));
      financialFields.forEach(field => {
        entry.totals[field] += UnifiedData.number(row[field]);
      });
    });
    return index;
  };
  const aggregateContracts = rows => {
    const firstRows = new Map();
    (rows || []).forEach(row => {
      const id = UnifiedData.key(row.contrato);
      if (id && !firstRows.has(id)) firstRows.set(id, row);
    });
    return [...contractIndex(rows)].map(_ref5 => {
      let [id, entry] = _ref5;
      const row = {
        ...firstRows.get(id),
        ...entry.metadata,
        ...entry.totals,
        contract_metadata: entry.metadata,
        contract_metadata_conflicts: [...entry.conflicts]
      };
      ['recebido', 'liquidado', 'pago', 'bloqueado', 'cancelado', 'executado', 'a_liquidar', 'a_pagar'].forEach(metric => {
        row['p_' + metric] = row.v_empenhado ? (row['v_' + metric] || 0) / row.v_empenhado : 0;
      });
      row.p_exec_liq = row.p_pago;
      row.dif_global = (row.v_global || 0) - row.v_empenhado;
      row.contrato_empenhado_total = row.v_empenhado;
      return row;
    });
  };
  const accountingBalances = rows => {
    const result = new Map();
    if (!rows || rows.length < 2) return result;
    const headers = rows[0].map(UnifiedData.key);
    const find = names => names.map(UnifiedData.key).map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1;
    const contractIndex = find(['COL_NR_CONTR_BASE', 'Contrato', 'Número Contrato', 'Numero Contrato']);
    const informationIndex = find(['ITEM_INFORMACAO', 'INTEN_INFORMACAO', 'Informação', 'Informacao']);
    const valueIndex = find(['Valor Item (R$)', 'Valor (R$)', 'VALOR', 'Valor']);
    if (contractIndex < 0 || informationIndex < 0 || valueIndex < 0) return result;
    const names = {
      EMPENHADO: 'v_empenhado',
      RECEBIDO: 'v_recebido',
      LIQUIDADO: 'v_liquidado',
      PAGO: 'v_pago',
      CANCELADO: 'v_cancelado',
      BLOQUEADO: 'v_bloqueado'
    };
    rows.slice(1).forEach(row => {
      const contract = UnifiedData.key(row[contractIndex]);
      const information = UnifiedData.normalize(row[informationIndex]);
      const name = Object.keys(names).find(label => information.includes(label));
      if (!contract || !name) return;
      if (!result.has(contract)) result.set(contract, {
        ...Object.fromEntries(metrics.map(field => [field, 0])),
        hasMovement: false
      });
      const target = result.get(contract);
      target[names[name]] += UnifiedData.number(row[valueIndex]);
      target.hasMovement = true;
    });
    return result;
  };
  const bounds = function () {
    let now = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : new Date();
    const today = new Date(todayTime(now));
    const monday = new Date(today);
    monday.setDate(today.getDate() - (today.getDay() + 6) % 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const future30 = new Date(today);
    future30.setDate(today.getDate() + 30);
    const recent7 = new Date(today);
    recent7.setDate(today.getDate() - 6);
    return {
      today: today.getTime(),
      monday: monday.getTime(),
      sunday: sunday.getTime(),
      future30: future30.getTime(),
      recent7: recent7.getTime()
    };
  };
  const formatDate = timestamp => new Intl.DateTimeFormat('pt-BR').format(new Date(timestamp));
  const loginSummary = function (contracts, documents) {
    let now = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : new Date();
    const period = bounds(now);
    const authorizedDocuments = documents || [];
    const canonicalContracts = aggregateContracts(contracts || []);
    const contractSupplier = row => {
      const metadata = row.contract_metadata || row;
      const supplier = String(metadata.fornecedor || row.fornecedor || '').trim();
      return {
        contract: row.contrato,
        supplier: supplier && supplier !== '-' ? supplier : 'N/I'
      };
    };
    const suppliersByContract = new Map(canonicalContracts.map(row => [UnifiedData.key(row.contrato), contractSupplier(row)]));
    const movementContracts = new Set(authorizedDocuments.filter(row => metrics.some(field => row[field.replace('v_', 'has_')])).map(row => UnifiedData.key(row.contrato)));
    const sections = new Map(),
      weekContracts = [],
      next30Contracts = [];
    let totalCount = 0,
      totalCents = 0;
    canonicalContracts.forEach(row => {
      const metadata = row.contract_metadata || row;
      const end = midnight(metadata.dtFimVal || metadata.data_fim);
      const inWeek = end !== null && end >= period.monday && end <= period.sunday;
      const inNext30 = end !== null && end >= period.today && end <= period.future30;
      if (inWeek || inNext30) {
        const classification = classify(row, metadata, movementContracts.has(UnifiedData.key(row.contrato)), now);
        const detail = {
          id: UnifiedData.key(row.contrato),
          ...contractSupplier(row),
          value: cents(metadata.v_global) / 100,
          endDate: end,
          status: classification.labels.find(label => /^(VIG|VENC) /.test(label)) || 'N/I — sem classificação',
          decorations: classification.labels.filter(label => label === 'CAN' || label === 'BLOQ')
        };
        if (inWeek) weekContracts.push(detail);
        if (inNext30) next30Contracts.push(detail);
      }
      if (phase(row, now) !== 'vigente') return;
      const section = metadata.sec_log && metadata.sec_log !== '-' ? metadata.sec_log : 'N/I';
      if (!sections.has(section)) sections.set(section, {
        section,
        count: 0,
        valueCents: 0
      });
      const target = sections.get(section);
      target.count++;
      target.valueCents += cents(metadata.v_global);
      totalCount++;
      totalCents += cents(metadata.v_global);
    });
    const contractOrder = (a, b) => a.endDate - b.endDate || String(a.contract).localeCompare(String(b.contract), 'pt-BR', {
      numeric: true
    });
    weekContracts.sort(contractOrder);
    next30Contracts.sort(contractOrder);
    const movements = {
      empenhado: {
        field: 'v_empenhado',
        documents: new Map(),
        valueCents: 0
      },
      recebido: {
        field: 'v_recebido',
        documents: new Map(),
        valueCents: 0
      },
      liquidado: {
        field: 'v_liquidado',
        documents: new Map(),
        valueCents: 0
      },
      pago: {
        field: 'v_pago',
        documents: new Map(),
        valueCents: 0
      }
    };
    authorizedDocuments.forEach(row => {
      const day = midnight(row.diaVal || row.dia);
      if (day === null || day < period.recent7 || day > period.today || !row.documento || row.documento === '-') return;
      Object.values(movements).forEach(target => {
        if (!row[target.field.replace('v_', 'has_')]) return;
        const id = UnifiedData.documentId(row);
        if (!target.documents.has(id)) target.documents.set(id, {
          id,
          document: row.documento,
          ug: row.ug || 'N/I',
          valueCents: 0,
          dateValues: new Set(),
          contractSuppliers: new Map(),
          contractBeneficiaries: new Map(),
          portalContexts: new Map()
        });
        const detail = target.documents.get(id),
          value = cents(row[target.field]);
        const contractKey = UnifiedData.key(row.contrato),
          contractNumber = String(row.contrato || '').trim();
        if (!detail.contractSuppliers.has(contractKey)) detail.contractSuppliers.set(contractKey, suppliersByContract.get(contractKey) || {
          contract: contractNumber && contractNumber !== '-' ? contractNumber : 'N/I',
          supplier: 'N/I'
        });
        if (target.field === 'v_recebido') {
          const name = String(row.favorecido || '').trim();
          const beneficiary = name && name !== '-' ? name : 'N/I';
          const pairKey = `${contractKey}|${UnifiedData.normalize(beneficiary)}|${UnifiedData.key(row.favorecido_cnpj)}`;
          if (!detail.contractBeneficiaries.has(pairKey)) detail.contractBeneficiaries.set(pairKey, {
            contract: detail.contractSuppliers.get(contractKey).contract,
            beneficiary
          });
        }
        const portalContexts = Object.prototype.hasOwnProperty.call(row, 'portal_contexts') ? Array.isArray(row.portal_contexts) ? row.portal_contexts : [] : [{
          ug: row.portal_ug ?? row.ug ?? '',
          gestao: row.gestao || ''
        }];
        portalContexts.forEach(context => {
          if (!context || typeof context !== 'object') return;
          const portalKey = [UnifiedData.key(context.ug), UnifiedData.key(context.gestao)].join('|');
          if (!detail.portalContexts.has(portalKey)) detail.portalContexts.set(portalKey, {
            ug: context.ug || '',
            gestao: context.gestao || ''
          });
        });
        detail.valueCents += value;
        detail.dateValues.add(day);
        target.valueCents += value;
      });
    });
    return {
      period,
      totalCount,
      totalValue: totalCents / 100,
      weekCount: weekContracts.length,
      next30Count: next30Contracts.length,
      weekContracts,
      next30Contracts,
      sections: [...sections.values()].sort((a, b) => a.section.localeCompare(b.section, 'pt-BR')).map(row => ({
        section: row.section,
        count: row.count,
        value: row.valueCents / 100
      })),
      movements: Object.fromEntries(Object.entries(movements).map(_ref6 => {
        let [name, row] = _ref6;
        const documents = [...row.documents.values()].map(detail => {
          const dateValues = [...detail.dateValues].sort((a, b) => a - b),
            dates = dateValues.map(formatDate);
          const contractSuppliers = [...detail.contractSuppliers.values()].sort((a, b) => String(a.contract).localeCompare(String(b.contract), 'pt-BR', {
            numeric: true
          }));
          const contractBeneficiaries = [...detail.contractBeneficiaries.values()].sort((a, b) => String(a.contract).localeCompare(String(b.contract), 'pt-BR', {
            numeric: true
          }) || a.beneficiary.localeCompare(b.beneficiary, 'pt-BR'));
          const suppliers = new Map(contractSuppliers.map(pair => [UnifiedData.key(pair.contract), pair.supplier]));
          const contractParties = contractBeneficiaries.map(pair => ({
            contract: pair.contract,
            supplier: suppliers.get(UnifiedData.key(pair.contract)) || 'N/I',
            beneficiary: pair.beneficiary
          }));
          return {
            id: detail.id,
            document: detail.document,
            ug: detail.ug,
            value: detail.valueCents / 100,
            date: dates.join('; '),
            dates,
            dateValue: dateValues[dateValues.length - 1],
            contractSuppliers,
            contractBeneficiaries,
            contractParties,
            portal_contexts: [...detail.portalContexts.values()]
          };
        }).sort((a, b) => b.dateValue - a.dateValue || String(a.document).localeCompare(String(b.document), 'pt-BR', {
          numeric: true
        }) || String(a.ug).localeCompare(String(b.ug), 'pt-BR'));
        const groups = new Map();
        documents.forEach(document => {
          // Each UG/document occurs once, under its latest date in the
          // period; its line retains every date contributing to its total.
          if (!groups.has(document.dateValue)) {
            const local = new Date(document.dateValue);
            const dateTime = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
            groups.set(document.dateValue, {
              dateValue: document.dateValue,
              date: formatDate(document.dateValue),
              dateTime,
              documents: [],
              portal_contexts: []
            });
          }
          const group = groups.get(document.dateValue);
          group.documents.push(document);
          document.portal_contexts.forEach(context => {
            if (!group.portal_contexts.some(existing => UnifiedData.key(existing.ug) === UnifiedData.key(context.ug) && UnifiedData.key(existing.gestao) === UnifiedData.key(context.gestao))) group.portal_contexts.push(context);
          });
        });
        return [name, {
          count: row.documents.size,
          value: row.valueCents / 100,
          documents,
          dayGroups: [...groups.values()]
        }];
      }))
    };
  };
  const accessText = control => {
    const limit = Number(control === null || control === void 0 ? void 0 : control.limite);
    if (!Number.isFinite(limit) || limit <= 0) return 'Sem limite diário de acessos';
    const remaining = control.restantes !== null && control.restantes !== undefined ? Number(control.restantes) : Math.max(0, limit - Number(control.usados || 0));
    const timezone = control.fuso ? `; reinício às 00:00 em ${control.fuso}` : '; reinício à meia-noite no fuso da Api';
    return `Acessos restantes (por usuário/dia; 1 por carga ou sincronização${timezone}): ${remaining}`;
  };
  return Object.freeze({
    cents,
    phase,
    classify,
    primaryFlag,
    contractIndex,
    aggregateContracts,
    accountingBalances,
    bounds,
    formatDate,
    loginSummary,
    accessText
  });
})();
function LoginSummaryModal(_ref7) {
  let {
    summary,
    user,
    onClose
  } = _ref7;
  const closeRef = useRef(null),
    dialogRef = useRef(null);
  useEffect(() => {
    var _closeRef$current;
    const previous = document.activeElement;
    (_closeRef$current = closeRef.current) === null || _closeRef$current === void 0 || _closeRef$current.focus();
    const keydown = event => {
      var _dialogRef$current, _dialogRef$current2, _dialogRef$current3;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(((_dialogRef$current = dialogRef.current) === null || _dialogRef$current === void 0 ? void 0 : _dialogRef$current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')) || []).filter(element => !element.disabled && element.getAttribute('aria-hidden') !== 'true');
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (!first) {
        var _closeRef$current2;
        event.preventDefault();
        (_closeRef$current2 = closeRef.current) === null || _closeRef$current2 === void 0 || _closeRef$current2.focus();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || !((_dialogRef$current2 = dialogRef.current) !== null && _dialogRef$current2 !== void 0 && _dialogRef$current2.contains(document.activeElement)))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !((_dialogRef$current3 = dialogRef.current) !== null && _dialogRef$current3 !== void 0 && _dialogRef$current3.contains(document.activeElement)))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      var _previous$focus;
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = oldOverflow;
      previous === null || previous === void 0 || (_previous$focus = previous.focus) === null || _previous$focus === void 0 || _previous$focus.call(previous);
    };
  }, [onClose]);
  if (!summary) return null;
  const p = summary.period;
  const contractList = (items, label) => !(items !== null && items !== void 0 && items.length) ? /*#__PURE__*/React.createElement("p", {
    className: "mt-3 text-sm text-slate-500"
  }, "Nenhum contrato neste per\xEDodo.") : /*#__PURE__*/React.createElement("div", {
    role: "region",
    "aria-label": label,
    tabIndex: 0,
    className: "mt-3 max-h-60 overflow-y-auto rounded-lg border border-slate-100 p-2 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
  }, /*#__PURE__*/React.createElement("ul", {
    className: "space-y-3 text-sm text-slate-700"
  }, items.map(row => {
    var _row$decorations;
    return /*#__PURE__*/React.createElement("li", {
      key: row.id,
      className: "break-words border-b border-slate-100 pb-3 last:border-0 last:pb-0"
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-bold"
    }, row.contract), ' – ', row.supplier, ' – ', /*#__PURE__*/React.createElement("span", {
      className: "tabular-nums"
    }, formatBRL(row.value)), ' – ', /*#__PURE__*/React.createElement("span", {
      className: "font-semibold"
    }, row.status), ((_row$decorations = row.decorations) === null || _row$decorations === void 0 ? void 0 : _row$decorations.length) > 0 && /*#__PURE__*/React.createElement("span", {
      className: "ml-1 text-xs text-slate-500"
    }, "(", row.decorations.join(' · '), ")"));
  })));
  const documentList = (movement, label, metric) => {
    var _movement$documents;
    return !((_movement$documents = movement.documents) !== null && _movement$documents !== void 0 && _movement$documents.length) ? /*#__PURE__*/React.createElement("p", {
      className: "mt-3 text-sm text-slate-500"
    }, "Nenhum documento neste per\xEDodo.") : /*#__PURE__*/React.createElement("div", {
      role: "region",
      "aria-label": `Documentos ${label.toLowerCase()}`,
      tabIndex: 0,
      className: "mt-3 max-h-60 overflow-y-auto rounded-lg border border-slate-100 p-2 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    }, /*#__PURE__*/React.createElement("div", {
      className: "space-y-3 text-[11px] leading-relaxed text-slate-700"
    }, movement.dayGroups.map(group => /*#__PURE__*/React.createElement("section", {
      key: group.dateTime,
      "aria-labelledby": `summary-${metric}-${group.dateTime}`
    }, /*#__PURE__*/React.createElement("h5", {
      id: `summary-${metric}-${group.dateTime}`,
      className: "mb-2 border-b border-slate-200 pb-1 text-[11px] font-bold text-slate-600"
    }, /*#__PURE__*/React.createElement("time", {
      dateTime: group.dateTime
    }, group.date)), /*#__PURE__*/React.createElement("ul", {
      className: "space-y-2 text-[11px] leading-relaxed text-slate-700"
    }, group.documents.map(row => /*#__PURE__*/React.createElement("li", {
      key: row.id,
      title: `UG ${row.ug} · Datas: ${row.date}`,
      className: "break-words border-b border-slate-100 pb-2 last:border-0 last:pb-0"
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-bold"
    }, /*#__PURE__*/React.createElement(PortalDocumentLink, {
      value: row.document,
      context: row
    })), ' – ', /*#__PURE__*/React.createElement("span", {
      className: "tabular-nums"
    }, formatBRL(row.value)), ' – ', metric === 'recebido' ? row.contractParties.map(pair => `${pair.contract} – ${pair.supplier} – ${pair.beneficiary}`).join('; ') : row.contractSuppliers.map(pair => `${pair.contract} – ${pair.supplier}`).join('; '), ' – ', row.date)))))));
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 p-3 md:p-6"
  }, /*#__PURE__*/React.createElement("section", {
    ref: dialogRef,
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "login-summary-title",
    className: "max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl md:p-8"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-5 flex items-start justify-between gap-4"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    id: "login-summary-title",
    className: "text-xl font-black text-slate-800"
  }, "Resumo de entrada"), /*#__PURE__*/React.createElement("p", {
    className: "mt-1 text-sm text-slate-500"
  }, user, " \xB7 ", ContractRules.formatDate(p.today))), /*#__PURE__*/React.createElement("button", {
    ref: closeRef,
    onClick: onClose,
    className: "rounded-lg bg-slate-800 px-4 py-2 text-sm font-bold text-white"
  }, "Abrir painel")), /*#__PURE__*/React.createElement("p", {
    className: "mb-5 text-xs text-slate-500"
  }, "Resumo de todos os dados permitidos para seu usu\xE1rio, antes dos filtros do painel."), /*#__PURE__*/React.createElement("h3", {
    className: "mb-3 text-sm font-black uppercase text-slate-700"
  }, "Contratos vigentes"), /*#__PURE__*/React.createElement("div", {
    className: "overflow-x-auto rounded-lg border border-slate-200"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-left text-sm"
  }, /*#__PURE__*/React.createElement("thead", {
    className: "bg-slate-100"
  }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    className: "p-3"
  }, "SEC LOG"), /*#__PURE__*/React.createElement("th", {
    className: "p-3 text-right"
  }, "Contratos"), /*#__PURE__*/React.createElement("th", {
    className: "p-3 text-right"
  }, "Valor contratado"))), /*#__PURE__*/React.createElement("tbody", null, summary.sections.map(row => /*#__PURE__*/React.createElement("tr", {
    key: row.section,
    className: "border-t border-slate-100"
  }, /*#__PURE__*/React.createElement("td", {
    className: "p-3 font-bold"
  }, row.section), /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right"
  }, row.count.toLocaleString('pt-BR')), /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right tabular-nums"
  }, formatBRL(row.value)))), summary.sections.length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: "3",
    className: "p-3 text-slate-500"
  }, "Nenhum contrato vigente nas bases permitidas."))), /*#__PURE__*/React.createElement("tfoot", {
    className: "bg-slate-800 font-black text-white"
  }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    className: "p-3"
  }, "TOTAL GERAL"), /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right"
  }, summary.totalCount.toLocaleString('pt-BR')), /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right tabular-nums"
  }, formatBRL(summary.totalValue)))))), /*#__PURE__*/React.createElement("div", {
    className: "my-5 grid gap-3 sm:grid-cols-2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "min-w-0 rounded-xl border border-slate-200 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold text-slate-700"
  }, "Vencendo nesta semana"), /*#__PURE__*/React.createElement("p", {
    className: "mt-1 text-xs text-slate-500"
  }, "Segunda a domingo: ", ContractRules.formatDate(p.monday), " a ", ContractRules.formatDate(p.sunday)), /*#__PURE__*/React.createElement("p", {
    className: "mt-2 text-2xl font-black text-blue-700"
  }, summary.weekCount.toLocaleString('pt-BR'), " contratos"), contractList(summary.weekContracts, 'Contratos vencendo nesta semana')), /*#__PURE__*/React.createElement("div", {
    className: "min-w-0 rounded-xl border border-slate-200 p-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-sm font-bold text-slate-700"
  }, "Vencendo nos pr\xF3ximos 30 dias"), /*#__PURE__*/React.createElement("p", {
    className: "mt-1 text-xs text-slate-500"
  }, "De ", ContractRules.formatDate(p.today), " a ", ContractRules.formatDate(p.future30), ", inclusive"), /*#__PURE__*/React.createElement("p", {
    className: "mt-2 text-2xl font-black text-blue-700"
  }, summary.next30Count.toLocaleString('pt-BR'), " contratos"), contractList(summary.next30Contracts, 'Contratos vencendo nos próximos 30 dias'))), /*#__PURE__*/React.createElement("h3", {
    className: "mb-1 text-sm font-black uppercase text-slate-700"
  }, "\xDAltimas movimenta\xE7\xF5es dos 7 dias"), /*#__PURE__*/React.createElement("p", {
    className: "mb-3 text-xs text-slate-500"
  }, ContractRules.formatDate(p.recent7), " a ", ContractRules.formatDate(p.today), ", inclusive. Valores dos lan\xE7amentos do per\xEDodo."), /*#__PURE__*/React.createElement("div", {
    className: "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
  }, [['empenhado', 'Empenhados'], ['recebido', 'Recebidos'], ['liquidado', 'Liquidados'], ['pago', 'Pagos']].map(_ref8 => {
    let [metric, label] = _ref8;
    return /*#__PURE__*/React.createElement("div", {
      key: metric,
      className: "min-w-0 rounded-xl border-t-4 border border-slate-200 p-4",
      style: metric === 'recebido' ? {
        borderTopColor: '#8b5cf6',
        color: '#6d28d9'
      } : MetricColors.cardStyle(metric)
    }, /*#__PURE__*/React.createElement("h4", {
      className: "text-sm font-bold"
    }, label), /*#__PURE__*/React.createElement("p", {
      className: "mt-2 break-words text-lg font-black"
    }, formatBRL(summary.movements[metric].value)), /*#__PURE__*/React.createElement("p", {
      className: "mt-1 text-xs text-slate-500"
    }, summary.movements[metric].count.toLocaleString('pt-BR'), " documentos"), documentList(summary.movements[metric], label, metric));
  }))));
}

// 3. APRESENTAÇÃO — mesma cor por métrica; OUTROS cinza nas barras e pizzas com escala térmica.
const MetricColors = (() => {
  const palette = Object.freeze({
    global: Object.freeze({
      color: '#1e293b',
      text: '#1e293b',
      soft: '#f8fafc'
    }),
    empenhado: Object.freeze({
      color: '#3b82f6',
      text: '#1d4ed8',
      soft: '#eff6ff'
    }),
    liquidado: Object.freeze({
      color: '#f59e0b',
      text: '#d97706',
      soft: '#fffbeb'
    }),
    pago: Object.freeze({
      color: '#10b981',
      text: '#059669',
      soft: '#ecfdf5'
    }),
    cancelado: Object.freeze({
      color: '#ef4444',
      text: '#dc2626',
      soft: '#fef2f2'
    }),
    bloqueado: Object.freeze({
      color: '#f97316',
      text: '#ea580c',
      soft: '#fff7ed'
    })
  });
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const fields = {};
  const add = (metric, names) => names.forEach(name => {
    fields[normalize(name)] = metric;
  });
  add('global', ['global', 'v_global', 'totalGlobal']);
  add('empenhado', ['empenhado', 'emp', 'total', 'v_emp', 'v_empenhado', 'totalEmpenhado', 'emp_tit', 'emp_sub', 'emp_total', 'sumVEmp', 'sumQtdEmp', 'qtd_emp', 'p_empenhado', 'pEmpGlobal', 'p_empenhado_100', 'percEmpenhadoDoGlobal']);
  add('liquidado', ['liquidado', 'liq', 'v_liq', 'v_liquidado', 'totalLiquidado', 'sumVLiq', 'sumQtdLiq', 'qtd_liq', 'p_liquidado', 'pLiq', 'percLiquidado', 'p_liquidado_table']);
  add('pago', ['pago', 'pag', 'v_pag', 'v_pago', 'totalPago', 'sumVPag', 'sumQtdPag', 'qtd_pag', 'p_pago', 'pPag', 'percPago', 'p_pago_table', 'execLiq', 'pExecLiq', 'p_exec_liq', 'Executado Líquido', '% Exec. Líquida', 'Pago (Exec Líq)', 'Pago / Exec Líq']);
  add('cancelado', ['cancelado', 'can', 'v_can', 'v_cancelado', 'totalCancelado', 'sumVCan', 'sumQtdCan', 'qtd_can', 'p_cancelado', 'pCan', 'percCancelado']);
  add('bloqueado', ['bloqueado', 'blo', 'bloq', 'v_bloq', 'v_bloqueado', 'totalBloqueado', 'sumVBloq', 'sumQtdBloq', 'qtd_bloq', 'p_bloqueado', 'pBlo', 'percBloqueado']);
  const key = value => {
    const normalized = normalize(value);
    if (fields[normalized]) return fields[normalized];
    const label = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
    if (/^(?:%\s*)?(?:VALOR\s+)?EMPENHADO\b|^EMP\.\s*(?:TITULAR|SUBSTITUTO)/.test(label)) return 'empenhado';
    if (/^(?:%\s*)?LIQUIDADO\b/.test(label)) return 'liquidado';
    if (/^(?:%\s*)?PAGO\b/.test(label)) return 'pago';
    if (/^(?:%\s*)?CANCELADO\b/.test(label)) return 'cancelado';
    if (/^(?:%\s*)?BLOQUEADO\b/.test(label)) return 'bloqueado';
    return undefined;
  };
  const get = value => palette[key(value)];
  const textStyle = value => get(value) ? {
    color: get(value).text
  } : undefined;
  const cardStyle = value => get(value) ? {
    color: get(value).text,
    borderTopColor: get(value).color
  } : undefined;
  const rgb = hex => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const alphaColor = function (hex, original) {
    let fallback = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 1;
    if (original === 'transparent') return original;
    const alpha = typeof original === 'string' && original.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/i);
    const opacity = alpha ? Number(alpha[1]) : fallback;
    return opacity < 1 ? `rgba(${rgb(hex).join(', ')}, ${opacity})` : hex;
  };
  // Financial pies compare categories within one metric. Related tones keep
  // those categories distinct without assigning another metric's hue.
  const shade = (metric, index) => {
    const base = rgb(get(metric).color);
    const weights = [0, .36, -.22, .18, -.12, .55, -.38, .7, -.5, .44];
    const weight = weights[index % weights.length];
    const target = weight < 0 ? 0 : 255;
    return '#' + base.map(channel => Math.round(channel + (target - channel) * Math.abs(weight)).toString(16).padStart(2, '0')).join('');
  };
  const personSeries = Object.freeze({
    qtdtitular: '#eab308',
    qtdsubstituto: '#fde047',
    emptitular: '#3b82f6',
    empsubstituto: '#93c5fd'
  });
  const thermalStops = ['#2563eb', '#06b6d4', '#22c55e', '#facc15', '#f97316', '#dc2626'];
  const thermalGradient = `linear-gradient(to right, ${thermalStops.join(', ')})`;
  const thermalColor = position => {
    const scaled = Math.max(0, Math.min(1, position)) * (thermalStops.length - 1);
    const index = Math.min(thermalStops.length - 2, Math.floor(scaled));
    const fraction = scaled - index;
    const from = rgb(thermalStops[index]),
      to = rgb(thermalStops[index + 1]);
    return '#' + from.map((channel, i) => Math.round(channel + (to[i] - channel) * fraction).toString(16).padStart(2, '0')).join('');
  };
  const pieColorsByValue = values => {
    const numbers = values.map(value => Number.isFinite(Number(value)) ? Number(value) : 0);
    const ordered = [...new Set(numbers)].sort((a, b) => a - b);
    const colors = new Map(ordered.map((value, index) => [value, thermalColor(ordered.length > 1 ? index / (ordered.length - 1) : 0.5)]));
    return numbers.map(value => colors.get(value));
  };
  const chartData = (data, chartType) => {
    if (!data || !data.datasets) return data;
    const colored = {
      ...data,
      datasets: data.datasets.map(dataset => {
        const metric = key(dataset.label);
        const type = dataset.type || chartType;
        const segmented = type === 'pie' || type === 'doughnut';
        // Pie slices encode their relative values, regardless of the chosen
        // metric. Ties share a color; OUTROS is ranked by its actual total.
        if (type === 'pie') return {
          ...dataset,
          backgroundColor: pieColorsByValue(dataset.data || [])
        };
        const personColor = personSeries[normalize(dataset.label)];
        if (personColor) return {
          ...dataset,
          backgroundColor: personColor,
          borderColor: personColor,
          datalabels: {
            ...dataset.datalabels,
            color: normalize(dataset.label) === 'emptitular' ? '#fff' : '#1e293b'
          }
        };
        if (!metric) {
          if (!segmented || dataset.label || !(data.labels || []).every(label => key(label) || normalize(label) === 'recebido')) return dataset;
          return {
            ...dataset,
            backgroundColor: data.labels.map((label, index) => {
              var _get, _dataset$backgroundCo;
              return ((_get = get(label)) === null || _get === void 0 ? void 0 : _get.color) || ((_dataset$backgroundCo = dataset.backgroundColor) === null || _dataset$backgroundCo === void 0 ? void 0 : _dataset$backgroundCo[index]);
            })
          };
        }
        const color = /SUBSTITUTO/i.test(dataset.label) ? shade(metric, 1) : palette[metric].color;
        const result = {
          ...dataset
        };
        result.backgroundColor = segmented ? (data.labels || []).map((_, index) => shade(metric, index)) : alphaColor(color, dataset.backgroundColor);
        if (!segmented) {
          result.borderColor = color;
          if (dataset.pointBackgroundColor !== undefined) result.pointBackgroundColor = color;
          if (dataset.pointBorderColor !== undefined) result.pointBorderColor = color;
          if (dataset.hoverBackgroundColor !== undefined) result.hoverBackgroundColor = color;
        }
        return result;
      })
    };
    const others = (data.labels || []).map(label => normalize(Array.isArray(label) ? label.join(' ') : label) === 'outros');
    if (!others.some(Boolean)) return colored;
    return {
      ...colored,
      datasets: colored.datasets.map(dataset => {
        if ((dataset.type || chartType) !== 'bar') return dataset;
        const result = {
          ...dataset
        };
        ['backgroundColor', 'borderColor', 'hoverBackgroundColor', 'hoverBorderColor'].forEach(property => {
          const original = dataset[property];
          if (original === undefined && property !== 'backgroundColor') return;
          result[property] = typeof original === 'function' ? context => others[context.dataIndex] ? '#94a3b8' : original(context) : others.map((isOther, index) => isOther ? '#94a3b8' : Array.isArray(original) ? original[index] : original);
        });
        return result;
      })
    };
  };
  return Object.freeze({
    palette,
    key,
    get,
    textStyle,
    cardStyle,
    chartData,
    thermalGradient
  });
})();

// Descriptions mirror the existing predicates; adding help does not change filters.
const QuickActionHelp = (() => {
  const date = value => String(value || '').split('-').reverse().join('/');
  const contractDateNote = ' Ao ativar, substitui os filtros de início e fim da vigência. Clique novamente para retirar esse recorte. Os demais filtros continuam valendo.';
  const statusNote = ' As comparações são feitas em centavos. As situações de execução são exclusivas; somente CAN e BLOQ podem aparecer junto delas. Se selecionar várias situações, basta atender a uma delas. Os demais filtros continuam valendo.';
  const statuses = Object.freeze({
    'VIG SEM EXEC': 'Contrato vigente, com início até hoje e fim hoje ou depois, cujo recebido é zero e que não se enquadra em execução total ou parcial. Sem qualquer movimentação, permanece nesta situação.',
    'VIG EM EXEC': 'Contrato vigente com recebido maior que zero e pago diferente do empenhado, que não se enquadra em execução parcial por cancelamento.',
    'VIG EXEC PARCIAL': 'Contrato vigente com cancelado maior que zero, em que o empenhado é igual à soma do pago com o cancelado. Tem prioridade sobre em execução e sem execução.',
    'VIG EXEC TOTAL': 'Contrato vigente em que o pago é igual ao empenhado. Se ambos forem zero e não houver nenhuma movimentação, a situação será VIG SEM EXEC.',
    'VENC INEXEC TOTAL': 'Contrato com fim da vigência anterior a hoje, cujo pago é igual a zero. Tem prioridade sobre as demais situações de contrato vencido.',
    'VENC EXEC TOTAL': 'Contrato com fim da vigência anterior a hoje, cujo pago é igual ao empenhado. Se o pago for zero, a situação será VENC INEXEC TOTAL.',
    'VENC EXEC PARCIAL': 'Contrato com fim da vigência anterior a hoje, cujo pago é menor que o empenhado. Se o pago for zero, a situação será VENC INEXEC TOTAL.',
    'CAN': 'Contrato com valor cancelado maior que zero. Não exige cancelamento integral.',
    'BLOQ': 'Contrato com valor bloqueado maior que zero. Não exige bloqueio integral.'
  });
  const movements = Object.freeze({
    EMP: 'empenho',
    RCB: 'recebimento',
    LIQ: 'liquidação',
    PAG: 'pagamento',
    BLOQ: 'bloqueio',
    CAN: 'cancelamento'
  });
  return Object.freeze({
    current: today => `Mostra contratos que começaram até hoje (${date(today)}) e cujo fim da vigência é hoje ou depois.` + contractDateNote,
    cSup: sections => 'Mostra apenas os contratos das quatro seções do C Sup: ' + sections.join(', ') + '. Clique novamente para retirar essa seleção.',
    outsideCSup: 'Mostra contratos das demais seções logísticas disponíveis na base, fora das quatro seções do C Sup. Clique novamente para retirar essa seleção.',
    clear: 'Limpa as seleções de filtros do painel e as buscas, datas e limites das tabelas principais de contratos e documentos. Os filtros próprios de cada subtabela são mantidos.',
    ending: (days, today, end) => `Mostra contratos com fim da vigência entre hoje (${date(today)}) e ${date(end)}, incluindo as duas datas: de hoje até daqui a ${days} dias. Não exige que o contrato já tenha começado.` + contractDateNote,
    existing: (days, start) => `Mostra contratos cujo fim da vigência é ${date(start)} (${days} dias atrás) ou depois, incluindo os que ainda vão vencer. Este atalho usa a data de fim, e não a data de início do contrato.` + contractDateNote,
    expired: (days, start, today) => `Mostra contratos com fim da vigência entre ${date(start)} (${days} dias atrás) e hoje (${date(today)}), incluindo as duas datas. Também inclui os contratos que terminam hoje.` + contractDateNote,
    status: label => statuses[label] ? statuses[label] + statusNote : '',
    onlyGeneral: 'Mostra contratos presentes na base geral que não têm lançamentos na base contábil carregada. A comparação considera as bases completas carregadas; os outros filtros continuam valendo. Clique novamente para retirar essa seleção.',
    onlyAccounting: 'Mostra lançamentos contábeis cujo contrato não foi encontrado na base geral carregada. A comparação considera as bases completas carregadas; os outros filtros continuam valendo. Clique novamente para retirar essa seleção.',
    documents: (days, start, today) => `Mostra documentos emitidos entre ${date(start)} (${days} dias atrás) e hoje (${date(today)}), incluindo as duas datas. Ajusta somente o período de emissão dos documentos; não altera a vigência dos contratos. Clique novamente para retirar esse período. Os outros filtros continuam valendo.`,
    latestDocument: latestDate => 'Mostra somente documentos emitidos na data mais recente encontrada em toda a base contábil carregada.' + (latestDate && latestDate !== '-' ? ` Última data encontrada: ${latestDate}.` : '') + ' Não altera a vigência dos contratos. Os outros filtros continuam valendo, mesmo que não haja documentos nessa data após as demais seleções. Clique novamente para retirar esse período.',
    movement: label => movements[label] ? `Mostra documentos com lançamento de ${movements[label]}, mesmo quando o valor é zero ou negativo. Se marcar mais de um movimento, basta o documento ter um deles. Os outros filtros continuam valendo. Clique novamente para retirar essa opção.` : ''
  });
})();
const {
  useState,
  useEffect,
  useMemo,
  useRef
} = React;
if (window.Chart) {
  Chart.defaults.font.family = "'Outfit', sans-serif";
  Chart.defaults.set('plugins.tooltip', {
    titleFont: {
      family: 'Outfit',
      weight: '700'
    },
    bodyFont: {
      family: 'Outfit',
      weight: '600'
    },
    footerFont: {
      family: 'Outfit',
      weight: '700'
    }
  });
}
if (window.ChartDataLabels) {
  Chart.register(ChartDataLabels);
  Chart.defaults.set('plugins.datalabels', {
    display: false
  });
}

// Plugin para linha vertical nos gráficos de barra
const customLinePlugin = {
  id: 'customLinePlugin',
  afterDatasetsDraw: chart => {
    const plugins = chart.config.options.plugins;
    const config = plugins && plugins.customLinePlugin;
    if (config && config.x !== undefined) {
      const ctx = chart.ctx;
      const scale = chart.scales[config.scaleID || 'x1'];
      const yAxis = chart.scales.y;
      if (!scale || !yAxis) return;
      const xPixel = scale.getPixelForValue(config.x);
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 5]);
      ctx.moveTo(xPixel, yAxis.top);
      ctx.lineTo(xPixel, yAxis.bottom);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
      ctx.stroke();
      ctx.restore();
    }
  }
};
Chart.register(customLinePlugin);

// Plugin exclusivo para desenhar as linhas conectando as fatias da Pizza aos valores externos
const pieLinePlugin = {
  id: 'pieLinePlugin',
  afterDraw: chart => {
    if (chart.config.type !== 'pie') return;
    const ctx = chart.ctx;
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data) return;
    ctx.save();
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.2;
    meta.data.forEach((element, index) => {
      const dataset = chart.data.datasets[0];
      const value = dataset.data[index];
      const total = dataset.data.reduce((a, b) => a + b, 0);
      if (!total || value === 0) return;
      const angle = (element.startAngle + element.endAngle) / 2;
      const outerRadius = element.outerRadius;
      const x = element.x;
      const y = element.y;
      const startX = x + Math.cos(angle) * outerRadius;
      const startY = y + Math.sin(angle) * outerRadius;
      const endX = x + Math.cos(angle) * (outerRadius + 15);
      const endY = y + Math.sin(angle) * (outerRadius + 15);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      const sign = Math.cos(angle) >= 0 ? 1 : -1;
      ctx.lineTo(endX + 5 * sign, endY);
      ctx.stroke();
    });
    ctx.restore();
  }
};
Chart.register(pieLinePlugin);

// Plugin para os Quadrantes no Gráfico de Dispersão
const scatterQuadrantPlugin = {
  id: 'scatterQuadrantPlugin',
  beforeDraw: chart => {
    var _chart$config$options;
    if ((_chart$config$options = chart.config.options.plugins.scatterQuadrantPlugin) !== null && _chart$config$options !== void 0 && _chart$config$options.display) {
      const ctx = chart.ctx;
      const xAxis = chart.scales.x;
      const yAxis = chart.scales.y;
      const x50 = xAxis.getPixelForValue(50);
      const y50 = yAxis.getPixelForValue(50);
      ctx.save();

      // Desenho das Linhas Tracejadas
      ctx.beginPath();
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#f472b6'; // Rosa

      // Vertical 50%
      ctx.moveTo(x50, yAxis.top);
      ctx.lineTo(x50, yAxis.bottom);
      // Horizontal 50%
      ctx.moveTo(xAxis.left, y50);
      ctx.lineTo(xAxis.right, y50);
      ctx.stroke();

      // Desenho dos Textos
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 28px Arial';
      const xLeftCenter = (xAxis.left + x50) / 2;
      const xRightCenter = (x50 + xAxis.right) / 2;
      const yTopCenter = (yAxis.top + y50) / 2; // Reflete > 50%
      const yBottomCenter = (y50 + yAxis.bottom) / 2; // Reflete < 50%

      // Q2: (x: 0-50, y: 50-100) -> Ruim (Vermelho translúcido)
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.fillText('Ruim', xLeftCenter, yTopCenter);

      // Q3: (x: 50-100, y: 50-100) -> Normal (Preto translúcido)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.fillText('Normal', xRightCenter, yTopCenter);

      // Q1: (x: 0-50, y: 0-50) -> Normal (Preto translúcido)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
      ctx.fillText('Normal', xLeftCenter, yBottomCenter);

      // Q4: (x: 50-100, y: 0-50) -> Ótimo (Verde translúcido)
      ctx.fillStyle = 'rgba(34, 197, 94, 0.3)';
      ctx.fillText('Ótimo', xRightCenter, yBottomCenter);
      ctx.restore();
    }
  }
};
Chart.register(scatterQuadrantPlugin);

// Linha Tracejada Vermelha para os 50% do Gráfico de 100%
const fiftyPercentLinePlugin = {
  id: 'fiftyPercentLinePlugin',
  afterDatasetsDraw: chart => {
    var _chart$config$options2;
    if ((_chart$config$options2 = chart.config.options.plugins.fiftyPercentLinePlugin) !== null && _chart$config$options2 !== void 0 && _chart$config$options2.display) {
      const ctx = chart.ctx;
      const yAxis = chart.scales.y;
      const xAxis = chart.scales.x;
      if (!yAxis || !xAxis) return;
      const y50 = yAxis.getPixelForValue(50);
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)'; // Vermelho
      ctx.moveTo(xAxis.left, y50);
      ctx.lineTo(xAxis.right, y50);
      ctx.stroke();
      ctx.restore();
    }
  }
};
Chart.register(fiftyPercentLinePlugin);

// Mapa de cores unificado para TAGS de Situação e Gráfico de Dispersão
const tagColorsMap = {
  'VIG SEM EXEC': {
    css: 'bg-purple-700 text-white',
    hex: '#7e22ce'
  },
  'VIG EM EXEC': {
    css: 'bg-cyan-500 text-slate-900',
    hex: '#06b6d4'
  },
  'VIG EXEC TOTAL': {
    css: 'bg-blue-800 text-white',
    hex: '#1e40af'
  },
  'VIG EXEC PARCIAL': {
    css: 'bg-sky-400 text-slate-900',
    hex: '#38bdf8'
  },
  'VENC INEXEC TOTAL': {
    css: 'bg-rose-900 text-white',
    hex: '#881337'
  },
  'VENC EXEC TOTAL': {
    css: 'bg-green-600 text-white',
    hex: '#16a34a'
  },
  'VENC EXEC PARCIAL': {
    css: 'bg-yellow-500 text-slate-900',
    hex: '#eab308'
  },
  'CAN': {
    css: 'bg-red-600 text-white',
    hex: '#dc2626'
  },
  'BLOQ': {
    css: 'bg-orange-500 text-white',
    hex: '#f97316'
  }
};

// Paleta base para Pizzas

const decodeBinary = binStr => {
  try {
    if (!binStr) return '';
    return binStr.trim().split(/\s+/).map(bin => {
      const parsed = parseInt(bin, 2);
      return isNaN(parsed) ? '' : String.fromCharCode(parsed);
    }).join('');
  } catch (e) {
    return '';
  }
};
const normalizeStr = str => {
  if (!str) return "";
  return str.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9%]/g, '');
};

// A API entrega somente as linhas autorizadas; a interface não amplia as permissões.
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwDf4gT-FPusNrbuXS0t-dE-LCLmqXmMVG7QX34GuQUHWc3EwjEargr1Mdi4DeXwpxf/exec";
const DASH_CACHE_KEY = 'dashData_TotalV6_total_v6';
const DASH_VERSION = 'V6';
const AUTH_STORAGE_KEYS = ['summary_pending_TotalV6', 'token_TotalV6', 'user_TotalV6', 'perfil_TotalV6', 'ativo_TotalV6', 'validade_TotalV6', 'duracao_diaria_horas_TotalV6', 'expira_TotalV6'];
const clearAuthStorage = () => {
  try {
    AUTH_STORAGE_KEYS.forEach(key => sessionStorage.removeItem(key));
  } catch (e) {}
};
const isAuthSessionValid = () => {
  try {
    const token = sessionStorage.getItem('token_TotalV6');
    if (!token) return false;
    const expiraEm = Number(sessionStorage.getItem('expira_TotalV6') || 0);
    if (expiraEm && Date.now() > expiraEm) {
      clearAuthStorage();
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
};
const readAppsScriptJson = async (response, operationLabel) => {
  const responseText = await response.text();
  try {
    return JSON.parse(responseText);
  } catch (parseError) {
    const normalized = normalizeStr(responseText || '');
    const missingDeployment = normalized.includes('paginanaoencontrada') || normalized.includes('naofoipossivelabriroarquivo') || normalized.includes('pagenotfound');
    if (missingDeployment) {
      throw new Error('A URL /exec do Apps Script não existe ou está incorreta. Atualize a implantação como Aplicativo da Web.');
    }
    const statusInfo = response && response.status ? ` HTTP ${response.status}.` : '';
    throw new Error(`O Apps Script retornou uma resposta inválida durante ${operationLabel}.${statusInfo}`);
  }
};
const parseValue = UnifiedData.number;
const parsePercentAsFloat = UnifiedData.percentNumber;
const formatBRL = UnifiedData.brl;
const formatPercentBR = UnifiedData.percent;
const formatDurationDays = value => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const numericValue = Math.trunc(Number(value));
  const sign = numericValue < 0 ? '- ' : '';
  let remaining = Math.abs(numericValue);
  const years = Math.floor(remaining / 365);
  remaining %= 365;
  const months = Math.floor(remaining / 30);
  const days = remaining % 30;
  const parts = [];
  if (years) parts.push(`${years} ${years === 1 ? 'ano' : 'anos'}`);
  if (months) parts.push(`${months} ${months === 1 ? 'mês' : 'meses'}`);
  if (days || parts.length === 0) parts.push(`${days} ${days === 1 ? 'dia' : 'dias'}`);
  return sign + parts.join(' ');
};
const splitBudgetDimensionValue = value => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized || normalized === '-') return [];
  return [...new Set(normalized.split(/\s*;\s*/).map(item => item.trim()).filter(Boolean))];
};
const getFornecedorCnpj = value => {
  const text = String(value ?? '').trim();
  const identifiers = new Set();
  const pattern = /(?:^|[^A-Za-z0-9])((?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14}))(?=$|[^A-Za-z0-9])/g;
  let match;
  while (match = pattern.exec(text)) identifiers.add(match[1].replace(/\D/g, ''));
  return identifiers.size === 1 ? [...identifiers][0] : '';
};
const counterpartyUrl = (name, identifier) => {
  const cnpj = getFornecedorCnpj(name) || getFornecedorCnpj(identifier);
  return cnpj ? 'https://portaldatransparencia.gov.br/pessoa-juridica/' + cnpj : '';
};
function ContractFileIcon(_ref9) {
  let {
    kind
  } = _ref9;
  const paths = {
    diarios: ['M7 3v4M17 3v4M4 10h16', 'M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z', 'M8 14h2M14 14h2M8 17h2'],
    docs: ['M8 3h8l4 4v14H8V3Z', 'M16 3v5h4M4 7v14h11', 'M11 12h6M11 16h6'],
    relatorio: ['M5 3h10l4 4v14H5V3Z', 'M15 3v5h4M9 17v-3M12 17v-6M15 17v-4'],
    dados: ['M20 6c0 2-3.6 3-8 3S4 8 4 6s3.6-3 8-3 8 1 8 3Z', 'M4 6v12c0 2 3.6 3 8 3s8-1 8-3V6M4 12c0 2 3.6 3 8 3s8-1 8-3']
  };
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    width: "18",
    height: "18",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    focusable: "false"
  }, paths[kind].map((d, index) => /*#__PURE__*/React.createElement("path", {
    key: index,
    d: d
  })));
}
function ContractFilesCell(_ref10) {
  let {
    row
  } = _ref10;
  return /*#__PURE__*/React.createElement("div", {
    className: "inline-grid w-max grid-cols-[repeat(2,28px)] gap-[4px] sm:grid-cols-[repeat(4,28px)]",
    "aria-label": `Arquivos do contrato ${row.contrato}`
  }, ContractFiles.fields.map(field => {
    const href = ContractFiles.get(row, field.key);
    const label = `${field.label} do contrato ${row.contrato}`;
    const shared = 'inline-flex h-[28px] w-[28px] items-center justify-center rounded border';
    return href ? /*#__PURE__*/React.createElement("a", {
      key: field.key,
      href: href,
      target: "_blank",
      rel: "noopener noreferrer",
      referrerPolicy: "no-referrer",
      title: `Abrir ${label} em nova aba`,
      "aria-label": `Abrir ${label} em nova aba`,
      className: `${shared} border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`
    }, /*#__PURE__*/React.createElement(ContractFileIcon, {
      kind: field.key
    })) : /*#__PURE__*/React.createElement("button", {
      key: field.key,
      type: "button",
      disabled: true,
      "aria-disabled": "true",
      title: `${label}: indisponível`,
      "aria-label": `${label}: indisponível`,
      className: `${shared} cursor-not-allowed border-slate-200 bg-slate-50 text-slate-300`
    }, /*#__PURE__*/React.createElement(ContractFileIcon, {
      kind: field.key
    }));
  }));
}
function CounterpartyLink(_ref11) {
  let {
    name,
    identifier,
    title = 'Abrir pessoa jurídica no Portal da Transparência'
  } = _ref11;
  const href = counterpartyUrl(name, identifier);
  return href ? /*#__PURE__*/React.createElement("a", {
    href: href,
    target: "_blank",
    rel: "noopener noreferrer",
    className: "text-blue-700 hover:text-blue-900 hover:underline",
    title: title
  }, name) : /*#__PURE__*/React.createElement("span", null, name);
}

// Document identifiers use the exact Portal da Transparencia paths supplied
// by the user. Short identifiers need actual issuer UG and management codes.
const PortalDocuments = (() => {
  const routes = Object.freeze({
    NE: 'empenho',
    NS: 'liquidacao',
    OB: 'pagamento',
    DF: 'pagamento'
  });
  const clean = value => String(value ?? '').trim().toUpperCase();
  const code = (value, width) => {
    const text = clean(value);
    return new RegExp('^\\d{1,' + width + '}$').test(text) ? text.padStart(width, '0') : '';
  };
  const full = value => clean(value).match(/^(\d{6})(\d{5})(\d{4})(NE|NS|OB|DF)(\d{6})$/);
  const short = value => clean(value).match(/^(\d{4})(NE|NS|OB|DF)(\d{6})$/);
  const url = function (value) {
    let context = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
    const complete = full(value);
    if (complete) return 'https://portaldatransparencia.gov.br/despesas/' + routes[complete[4]] + '/' + complete[0];
    const partial = short(value);
    if (!partial) return '';
    const hasContexts = Object.prototype.hasOwnProperty.call(context || {}, 'portal_contexts');
    const contexts = hasContexts ? context.portal_contexts : [context];
    if (!Array.isArray(contexts) || !contexts.length) return '';
    const candidates = new Set();
    for (const item of contexts) {
      const ug = code((item === null || item === void 0 ? void 0 : item.portal_ug) ?? (item === null || item === void 0 ? void 0 : item.ug), 6),
        management = code(item === null || item === void 0 ? void 0 : item.gestao, 5);
      if (!ug || !management) return '';
      candidates.add(ug + management + partial[0]);
    }
    return candidates.size === 1 ? 'https://portaldatransparencia.gov.br/despesas/' + routes[partial[2]] + '/' + [...candidates][0] : '';
  };
  return Object.freeze({
    url,
    full,
    short
  });
})();
function PortalDocumentLink(_ref12) {
  let {
    value,
    context,
    children
  } = _ref12;
  const href = PortalDocuments.url(value, context),
    label = children ?? value;
  return href ? /*#__PURE__*/React.createElement("a", {
    href: href,
    target: "_blank",
    rel: "noopener noreferrer",
    className: "text-blue-700 hover:text-blue-900 hover:underline",
    title: "Abrir documento no Portal da Transpar\xEAncia"
  }, label) : /*#__PURE__*/React.createElement("span", null, label);
}
function PortalDocumentTableValue(_ref13) {
  let {
    value,
    row,
    field
  } = _ref13;
  if (['documento', 'document', 'empenho'].includes(field)) return /*#__PURE__*/React.createElement(PortalDocumentLink, {
    value: value,
    context: row
  });
  // Top20 commitment subjects also display the contract and issuer. Only the
  // actual commitment number is clickable; contract text remains unchanged.
  if (['subject', 'label'].includes(field) && row.empenho && typeof value === 'string' && value.startsWith(row.empenho) && (PortalDocuments.full(row.empenho) || PortalDocuments.short(row.empenho))) {
    return /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement(PortalDocumentLink, {
      value: row.empenho,
      context: row
    }), value.slice(row.empenho.length));
  }
  return value;
}
const shortenNumber = num => {
  if (!num) return "0";
  if (num >= 1e9) return (num / 1e9).toFixed(1).replace('.', ',') + ' Bi';
  if (num >= 1e6) return (num / 1e6).toFixed(1).replace('.', ',') + ' Mi';
  if (num >= 1e3) return (num / 1e3).toFixed(1).replace('.', ',') + ' Mil';
  return num.toString();
};
const parseDateBR = UnifiedData.date;
const formatLabelMultiLine = function (text) {
  let maxLength = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 18;
  if (!text) return [""];
  let cleanText = text.replace(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\s*-\s*/, '');
  if (cleanText.length <= maxLength) return [cleanText];
  const words = cleanText.split(' ');
  let lines = [];
  let currentLine = '';
  words.forEach(word => {
    if ((currentLine + word).length > maxLength) {
      if (currentLine) lines.push(currentLine.trim());
      currentLine = word + ' ';
    } else {
      currentLine += word + ' ';
    }
  });
  if (currentLine) lines.push(currentLine.trim());
  if (lines.length > 2) return [lines[0], lines[1].substring(0, maxLength - 3) + '...'];
  return lines;
};
const getExportMetadata = () => {
  const metadataElement = document.querySelector('[data-access-metadata]');
  const accessLocation = (metadataElement === null || metadataElement === void 0 ? void 0 : metadataElement.dataset.accessLocation) || 'LOCALIZAÇÃO INDISPONÍVEL';
  const now = new Date();
  const datePart = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).format(now);
  const timePart = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(now);
  return [`${accessLocation} – ${datePart}; ${timePart}`, `Versão ${DASH_VERSION}`, 'Produzido por Cel Brito'];
};
const sanitizeFilename = value => String(value || 'exportacao').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 90) || 'exportacao';
const formatExportCell = (row, column) => {
  let value = column.format ? column.format(row) : row[column.key];
  if (value === null || value === undefined || value === '') return '-';
  if (column.isPercent) return formatPercentBR(value);
  if (column.isCurrency) return formatBRL(value);
  return value;
};

// Export-only typography and callouts for the page-one statistics cards.
const StatisticsPng = (() => {
  const applies = config => /^(?:pie|bar)-/.test((config === null || config === void 0 ? void 0 : config.exportId) || '') || ['gGestor', 'gFiscal'].includes(config === null || config === void 0 ? void 0 : config.exportId);
  const minimumHeight = (config, width) => {
    var _config$options, _config$data;
    return ((_config$options = config.options) === null || _config$options === void 0 ? void 0 : _config$options.indexAxis) === 'y' ? Math.ceil(Math.max(width * .75, ((((_config$data = config.data) === null || _config$data === void 0 || (_config$data = _config$data.labels) === null || _config$data === void 0 ? void 0 : _config$data.length) || 1) * 104 + 400) * width / 1600)) : Math.ceil(width * .75);
  };
  const distribute = (items, minY, maxY, gap) => {
    const ordered = items.map(item => ({
      ...item
    })).sort((a, b) => a.desiredY - b.desiredY);
    if (!ordered.length) return ordered;
    ordered.forEach((item, index) => {
      item.y = Math.max(item.desiredY, index ? ordered[index - 1].y + gap : minY);
    });
    if (ordered[ordered.length - 1].y > maxY) {
      ordered[ordered.length - 1].y = maxY;
      for (let index = ordered.length - 2; index >= 0; index--) ordered[index].y = Math.min(ordered[index].y, ordered[index + 1].y - gap);
    }
    if (ordered[0].y < minY) ordered.forEach((item, index) => {
      item.y = minY + index * gap;
    });
    return ordered;
  };
  const configure = (input, width) => {
    var _plugins$legend, _plugins$legend2, _input$data;
    const unit = width / 1600;
    const font = function (value) {
      let minimum = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 24;
      return typeof value === 'function' ? context => font(value(context), minimum) : {
        ...(value || {}),
        size: Math.ceil(Math.max(minimum, (Number(value === null || value === void 0 ? void 0 : value.size) || 12) * 2.5) * unit)
      };
    };
    const labelsOptions = value => value === false ? false : {
      ...(value || {}),
      font: font(value === null || value === void 0 ? void 0 : value.font, 26),
      offset: Math.ceil(Math.max(8, Number((value === null || value === void 0 ? void 0 : value.offset) || 0) * 2.5) * unit),
      clip: false,
      clamp: true
    };
    const original = input.options || {},
      plugins = original.plugins || {};
    const pie = input.type === 'pie' || input.type === 'doughnut';
    const datalabels = labelsOptions(plugins.datalabels);
    const legend = plugins.legend === false ? false : {
      ...plugins.legend,
      labels: {
        ...((_plugins$legend = plugins.legend) === null || _plugins$legend === void 0 ? void 0 : _plugins$legend.labels),
        font: font((_plugins$legend2 = plugins.legend) === null || _plugins$legend2 === void 0 || (_plugins$legend2 = _plugins$legend2.labels) === null || _plugins$legend2 === void 0 ? void 0 : _plugins$legend2.font, 26),
        boxWidth: Math.ceil(20 * unit),
        boxHeight: Math.ceil(20 * unit),
        padding: Math.ceil(18 * unit)
      }
    };
    const config = {
      ...input,
      options: {
        ...original,
        responsive: false,
        maintainAspectRatio: false,
        animation: false,
        devicePixelRatio: 1,
        font: font(original.font),
        layout: {
          ...original.layout,
          padding: pie ? {
            top: Math.ceil(80 * unit),
            right: Math.ceil(240 * unit),
            bottom: Math.ceil(75 * unit),
            left: Math.ceil(240 * unit)
          } : {
            top: Math.ceil(130 * unit),
            right: Math.ceil(75 * unit),
            bottom: Math.ceil(110 * unit),
            left: Math.ceil(90 * unit)
          }
        },
        plugins: {
          ...plugins,
          legend,
          datalabels: pie ? false : datalabels,
          ...(pie ? {
            pieLinePlugin: false
          } : {})
        },
        scales: original.scales ? Object.fromEntries(Object.entries(original.scales).map(_ref14 => {
          var _scale$ticks, _scale$title;
          let [key, scale] = _ref14;
          return [key, {
            ...scale,
            ticks: {
              ...scale.ticks,
              font: font((_scale$ticks = scale.ticks) === null || _scale$ticks === void 0 ? void 0 : _scale$ticks.font),
              padding: Math.ceil(8 * unit)
            },
            title: {
              ...scale.title,
              font: font((_scale$title = scale.title) === null || _scale$title === void 0 ? void 0 : _scale$title.font, 26)
            }
          }];
        })) : undefined
      },
      data: {
        ...input.data,
        datasets: (((_input$data = input.data) === null || _input$data === void 0 ? void 0 : _input$data.datasets) || []).map(dataset => ({
          ...dataset,
          ...(dataset.datalabels !== undefined ? {
            datalabels: pie ? false : labelsOptions(dataset.datalabels)
          } : {})
        }))
      }
    };
    if (pie && plugins.datalabels !== false) config.plugins = [...(input.plugins || []), {
      id: 'statisticsExportLabels',
      afterDatasetsDraw(chart) {
        var _meta$data;
        if (chart.isDatasetVisible && !chart.isDatasetVisible(0)) return;
        const dataset = chart.data.datasets[0],
          meta = chart.getDatasetMeta(0),
          ctx = chart.ctx;
        if (!dataset || !(meta !== null && meta !== void 0 && (_meta$data = meta.data) !== null && _meta$data !== void 0 && _meta$data.length)) return;
        const sides = {
          left: [],
          right: []
        };
        const annotationFont = typeof datalabels.font === 'function' ? datalabels.font({
          chart,
          dataset,
          datasetIndex: 0,
          dataIndex: 0
        }) : datalabels.font;
        const size = annotationFont.size,
          lineHeight = Math.ceil(size * 1.2),
          gap = lineHeight * 2 + Math.ceil(16 * unit);
        const top = chart.chartArea.top + lineHeight,
          bottom = chart.chartArea.bottom - lineHeight;
        meta.data.forEach((arc, dataIndex) => {
          const value = dataset.data[dataIndex];
          if (!Number(value) || chart.getDataVisibility && !chart.getDataVisibility(dataIndex)) return;
          const context = {
            chart,
            dataset,
            dataIndex,
            datasetIndex: 0,
            active: false
          };
          const formatted = typeof datalabels.formatter === 'function' ? datalabels.formatter(value, context) : value;
          const lines = Array.isArray(formatted) ? formatted.map(String) : String(formatted ?? '').split('\n');
          if (!lines.some(Boolean)) return;
          const angle = (arc.startAngle + arc.endAngle) / 2,
            side = Math.cos(angle) < 0 ? 'left' : 'right';
          const sign = side === 'left' ? -1 : 1;
          sides[side].push({
            lines,
            desiredY: arc.y + Math.sin(angle) * (arc.outerRadius + 25 * unit),
            startX: arc.x + Math.cos(angle) * arc.outerRadius,
            startY: arc.y + Math.sin(angle) * arc.outerRadius,
            elbowX: arc.x + sign * (arc.outerRadius + 25 * unit),
            textX: side === 'left' ? chart.chartArea.left - 35 * unit : chart.chartArea.right + 35 * unit
          });
        });
        ctx.save();
        ctx.font = `${annotationFont.weight || 'bold'} ${size}px ${annotationFont.family || 'Outfit, Arial, sans-serif'}`;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = datalabels.color || '#334155';
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.5 * unit;
        Object.entries(sides).forEach(_ref15 => {
          let [side, items] = _ref15;
          return distribute(items, top, bottom, Math.min(gap, items.length > 1 ? (bottom - top) / (items.length - 1) : gap)).forEach(item => {
            const sign = side === 'left' ? -1 : 1;
            ctx.beginPath();
            ctx.moveTo(item.startX, item.startY);
            ctx.lineTo(item.elbowX, item.y);
            ctx.lineTo(item.textX - sign * 10 * unit, item.y);
            ctx.stroke();
            ctx.textAlign = side === 'left' ? 'right' : 'left';
            item.lines.forEach((line, index) => ctx.fillText(line, item.textX, item.y + (index - (item.lines.length - 1) / 2) * lineHeight));
          });
        });
        ctx.restore();
      }
    }];
    return config;
  };
  return Object.freeze({
    applies,
    minimumHeight,
    configure,
    distribute
  });
})();

// 4. EXPORTAÇÃO — dados escalares preservados; renderizadores e links ficam na interface.
const ExportData = (() => {
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const joinedLabel = value => Array.isArray(value) ? value.join(' ') : String(value == null ? '' : value);
  const moneySeries = label => !/QTD|QUANT|CONTRATOS|INICIADOS|ENCERRADOS|DURANTE/i.test(label) && /EMPENH|RECEB|LIQUID|PAGO|BLOQ|CANCEL|VALOR|GLOBAL|EXECUTADO/i.test(label);
  const pointNames = {
    contrato: 'CONTRATO',
    situacao: 'SITUAÇÃO',
    fornecedor: 'FORNECEDOR',
    objeto: 'OBJETO',
    sec_log: 'SEC LOG',
    empenho: 'EMPENHO',
    dia: 'DIA',
    v_global: 'GLOBAL',
    v_empenhado: 'EMPENHADO',
    v_recebido: 'RECEBIDO',
    v_liquidado: 'LIQUIDADO',
    v_pago: 'PAGO',
    v_cancelado: 'CANCELADO',
    v_bloqueado: 'BLOQUEADO',
    perc_tempo: '% TEMPO',
    dias_passaram: 'DIAS DECORRIDOS',
    duracao_total_dias: 'DURAÇÃO EM DIAS',
    encerrando_dias: 'DIAS RESTANTES',
    r: 'TAMANHO DA BOLHA'
  };
  const chartRows = (data, type, chart, percentUnit, id) => {
    const datasets = ((data === null || data === void 0 ? void 0 : data.datasets) || []).map((dataset, index) => ({
      dataset,
      index
    })).filter(_ref16 => {
      let {
        dataset,
        index
      } = _ref16;
      return dataset.hidden !== true && (!(chart !== null && chart !== void 0 && chart.isDatasetVisible) || chart.isDatasetVisible(index));
    });
    const visiblePoint = index => !(type === 'pie' || type === 'doughnut') || !(chart !== null && chart !== void 0 && chart.getDataVisibility) || chart.getDataVisibility(index);
    const objectData = datasets.some(_ref17 => {
      let {
        dataset
      } = _ref17;
      return (dataset.data || []).some(point => point && typeof point === 'object' && !Array.isArray(point));
    });
    if (objectData) {
      const rows = [],
        keys = new Set();
      datasets.forEach(_ref18 => {
        let {
          dataset,
          index
        } = _ref18;
        return (dataset.data || []).forEach((point, pointIndex) => {
          if (!visiblePoint(pointIndex) || !point || typeof point !== 'object') return;
          const contractPoint = Object.prototype.hasOwnProperty.call(point, 'contrato') || Object.prototype.hasOwnProperty.call(point, 'v_empenhado');
          const row = {
            serie: dataset.label || `SÉRIE ${index + 1}`,
            ...point
          };
          if (!contractPoint) {
            var _data$labels;
            row.periodo = point.x ?? ((_data$labels = data.labels) === null || _data$labels === void 0 ? void 0 : _data$labels[pointIndex]) ?? '';
            row.valor = point.y ?? null;
            delete row.x;
            delete row.y;
          }
          Object.keys(row).forEach(key => {
            if (key !== 'color' && !key.startsWith('_') && (row[key] === null || typeof row[key] !== 'object')) keys.add(key);
          });
          rows.push(row);
        });
      });
      const monetaryY = datasets.every(_ref19 => {
        let {
          dataset
        } = _ref19;
        return moneySeries(dataset.label || '');
      });
      return {
        rows,
        columns: [...keys].map(key => ({
          header: key === 'serie' ? 'SÉRIE' : key === 'periodo' ? 'PERÍODO' : key === 'valor' ? 'VALOR' : key === 'x' ? 'EIXO X (%)' : key === 'y' ? 'EIXO Y (%)' : pointNames[key] || key.replace(/_/g, ' ').toUpperCase(),
          key,
          isCurrency: key.startsWith('v_') || key === 'valor' && monetaryY,
          isPercent: key.startsWith('p_') || key === 'perc_tempo',
          format: ['x', 'y'].includes(key) ? row => numeric(row[key]) ? `${row[key].toLocaleString('pt-BR', {
            maximumFractionDigits: 2
          })}%` : joinedLabel(row[key]) : undefined
        }))
      };
    }
    const rows = ((data === null || data === void 0 ? void 0 : data.labels) || []).flatMap((label, index) => {
      if (!visiblePoint(index)) return [];
      const row = {
        subject: joinedLabel(label)
      };
      datasets.forEach(_ref20 => {
        var _dataset$data;
        let {
          dataset,
          index: datasetIndex
        } = _ref20;
        row[`dataset_${datasetIndex}`] = ((_dataset$data = dataset.data) === null || _dataset$data === void 0 ? void 0 : _dataset$data[index]) ?? null;
      });
      return [row];
    });
    const columns = [{
      header: 'ASSUNTO',
      key: 'subject'
    }, ...datasets.map(_ref21 => {
      let {
        dataset,
        index
      } = _ref21;
      const label = dataset.label || `SÉRIE ${index + 1}`,
        isPercent = label.includes('%');
      const unit = dataset.exportPercentUnit || percentUnit || (id === 'gContrato' ? 'fraction' : 'percent');
      return {
        header: label.toUpperCase(),
        key: `dataset_${index}`,
        isCurrency: !isPercent && moneySeries(label),
        format: isPercent ? row => unit === 'fraction' ? formatPercentBR(row[`dataset_${index}`]) : `${Number(row[`dataset_${index}`] || 0).toLocaleString('pt-BR', {
          maximumFractionDigits: 2
        })}%` : undefined
      };
    })];
    if ((type === 'pie' || type === 'doughnut') && datasets.length === 1) {
      const {
          dataset,
          index
        } = datasets[0],
        total = (dataset.data || []).reduce((sum, value) => sum + Number(value || 0), 0);
      rows.forEach(row => {
        row.share = total ? Number(row[`dataset_${index}`] || 0) / total : 0;
      });
      columns.push({
        header: '% DA SÉRIE',
        key: 'share',
        isPercent: true
      });
    }
    return {
      rows,
      columns
    };
  };
  const wrap = (context, text, width) => {
    const lines = [];
    String(text || '').split(/\r?\n/).forEach(paragraph => {
      let line = '';
      paragraph.split(/\s+/).forEach(word => {
        if (line && context.measureText(`${line} ${word}`).width > width) {
          lines.push(line);
          line = '';
        }
        if (context.measureText(word).width > width) {
          if (line) {
            lines.push(line);
            line = '';
          }
          for (const character of word) {
            if (context.measureText(line + character).width > width) {
              lines.push(line);
              line = '';
            }
            line += character;
          }
        } else line += (line ? ' ' : '') + word;
      });
      lines.push(line);
    });
    return lines;
  };
  const clone = value => Array.isArray(value) ? value.map(clone) : value && Object.getPrototypeOf(value) === Object.prototype ? Object.fromEntries(Object.entries(value).map(_ref22 => {
    let [key, item] = _ref22;
    return [key, clone(item)];
  })) : value;
  const png = async (canvas, filename, title, chartConfig, visibleChart) => {
    if (!canvas) {
      alert('Gráfico não encontrado para exportação.');
      return;
    }
    let chart,
      holder,
      image = canvas;
    try {
      var _document$fonts;
      if ((_document$fonts = document.fonts) !== null && _document$fonts !== void 0 && _document$fonts.ready) await document.fonts.ready;
      if (chartConfig) {
        var _chartConfig$options, _chartConfig$data$lab, _config$options2, _config$options3, _config$options4;
        holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;';
        image = document.createElement('canvas');
        holder.appendChild(image);
        document.body.appendChild(holder);
        const horizontal = ((_chartConfig$options = chartConfig.options) === null || _chartConfig$options === void 0 ? void 0 : _chartConfig$options.indexAxis) === 'y';
        image.width = Math.max(1600, Math.min(2600, canvas.width));
        image.height = horizontal ? Math.min(16000, Math.max(900, (((_chartConfig$data$lab = chartConfig.data.labels) === null || _chartConfig$data$lab === void 0 ? void 0 : _chartConfig$data$lab.length) || 1) * 34 + 260)) : Math.max(1000, Math.min(1600, Math.round(image.width * canvas.height / Math.max(canvas.width, 1))));
        let config = clone(chartConfig);
        config.options = {
          ...config.options,
          responsive: false,
          maintainAspectRatio: false,
          animation: false,
          devicePixelRatio: 1,
          layout: {
            padding: {
              top: 70,
              right: 120,
              bottom: 90,
              left: 120
            }
          },
          plugins: {
            ...((_config$options2 = config.options) === null || _config$options2 === void 0 ? void 0 : _config$options2.plugins),
            legend: {
              ...((_config$options3 = config.options) === null || _config$options3 === void 0 || (_config$options3 = _config$options3.plugins) === null || _config$options3 === void 0 ? void 0 : _config$options3.legend),
              labels: {
                ...((_config$options4 = config.options) === null || _config$options4 === void 0 || (_config$options4 = _config$options4.plugins) === null || _config$options4 === void 0 || (_config$options4 = _config$options4.legend) === null || _config$options4 === void 0 ? void 0 : _config$options4.labels),
                font: {
                  size: 12
                },
                padding: 16
              }
            }
          }
        };
        if (StatisticsPng.applies(chartConfig)) {
          image.height = Math.max(image.height, StatisticsPng.minimumHeight(chartConfig, image.width));
          config = StatisticsPng.configure(clone(chartConfig), image.width);
        }
        delete config.exportId;
        config.data.datasets = config.data.datasets.map((dataset, index) => ({
          ...dataset,
          hidden: visibleChart !== null && visibleChart !== void 0 && visibleChart.isDatasetVisible ? !visibleChart.isDatasetVisible(index) : dataset.hidden
        }));
        chart = new Chart(image.getContext('2d'), config);
        if (visibleChart !== null && visibleChart !== void 0 && visibleChart.getDataVisibility && ['pie', 'doughnut'].includes(config.type)) config.data.labels.forEach((_, index) => {
          if (!visibleChart.getDataVisibility(index)) chart.toggleDataVisibility(index);
        });
        chart.update('none');
      }
      const output = document.createElement('canvas'),
        context = output.getContext('2d');
      const scale = Math.max(1, image.width / (StatisticsPng.applies(chartConfig) ? 800 : 1100)),
        padding = Math.ceil(26 * scale),
        lineHeight = Math.ceil(20 * scale);
      output.width = image.width + padding * 2;
      context.font = `800 ${Math.ceil(17 * scale)}px Outfit, Arial, sans-serif`;
      const titleLines = wrap(context, String(title || 'Gráfico').toUpperCase(), image.width);
      context.font = `600 ${Math.ceil(11 * scale)}px Outfit, Arial, sans-serif`;
      const metadataLines = getExportMetadata().flatMap(line => wrap(context, line, image.width));
      const headerHeight = padding * 2 + titleLines.length * lineHeight;
      const footerHeight = padding * 2 + metadataLines.length * lineHeight;
      output.height = image.height + headerHeight + footerHeight;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, output.width, output.height);
      context.fillStyle = '#1e293b';
      context.font = `800 ${Math.ceil(17 * scale)}px Outfit, Arial, sans-serif`;
      titleLines.forEach((line, index) => context.fillText(line, padding, padding + (index + 1) * lineHeight));
      context.drawImage(image, padding, headerHeight);
      context.fillStyle = '#475569';
      context.font = `600 ${Math.ceil(11 * scale)}px Outfit, Arial, sans-serif`;
      metadataLines.forEach((line, index) => context.fillText(line, padding, headerHeight + image.height + padding + (index + 1) * lineHeight));
      const link = document.createElement('a');
      link.download = `${sanitizeFilename(filename)}.png`;
      link.href = output.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error(error);
      alert('Não foi possível exportar a imagem completa. Tente novamente após o gráfico terminar de carregar.');
    } finally {
      if (chart) chart.destroy();
      if (holder) holder.remove();
    }
  };
  return {
    numeric,
    chartRows,
    wrap,
    png
  };
})();
const exportTable = {
  toExcel: (data, filename, columns) => {
    if (!window.XLSX) {
      alert('Biblioteca Excel não encontrada.');
      return;
    }
    const value = (row, column) => !column.format && ExportData.numeric(row[column.key]) ? row[column.key] : formatExportCell(row, column);
    const rows = [columns.map(column => column.header), ...data.map(row => columns.map(column => value(row, column))), [], ...getExportMetadata().map(line => [line])];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    columns.forEach((column, index) => data.forEach((row, rowIndex) => {
      const cell = ws[XLSX.utils.encode_cell({
        r: rowIndex + 1,
        c: index
      })];
      if ((cell === null || cell === void 0 ? void 0 : cell.t) === 'n') cell.z = column.isCurrency ? '"R$" #,##0.00;[Red]-"R$" #,##0.00' : column.isPercent ? '0.00%' : '#,##0.00';
    }));
    ws['!cols'] = columns.map((column, index) => ({
      wch: Math.min(60, Math.max(12, ...rows.slice(0, 101).map(row => String(row[index] ?? '').length + 2)))
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dados');
    XLSX.writeFile(wb, `${sanitizeFilename(filename)}.xlsx`);
  },
  toCSV: (data, filename, columns) => {
    const escape = value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const rows = [columns.map(column => column.header), ...data.map(row => columns.map(column => formatExportCell(row, column))), [], ...getExportMetadata().map(line => [line])];
    const text = '\uFEFF' + rows.map(row => row.map(value => escape(typeof value === 'number' ? value.toString().replace('.', ',') : value)).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([text], {
      type: 'text/csv;charset=utf-8;'
    }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeFilename(filename)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  toPDF: (data, filename, columns, title) => {
    var _window$jspdf;
    if (!((_window$jspdf = window.jspdf) !== null && _window$jspdf !== void 0 && _window$jspdf.jsPDF)) {
      alert('Biblioteca PDF não encontrada.');
      return;
    }
    const doc = new window.jspdf.jsPDF('l', 'pt', columns.length > 8 ? 'a3' : 'a4');
    const width = doc.internal.pageSize.getWidth(),
      height = doc.internal.pageSize.getHeight();
    doc.setFontSize(13);
    const heading = doc.splitTextToSize(String(title || filename), width - 64),
      top = 28 + heading.length * 16;
    doc.autoTable({
      head: [columns.map(column => column.header)],
      body: data.map(row => columns.map(column => String(formatExportCell(row, column)))),
      startY: top,
      horizontalPageBreak: true,
      horizontalPageBreakRepeat: 0,
      styles: {
        fontSize: 7,
        cellPadding: 4,
        overflow: 'linebreak',
        minCellWidth: 58
      },
      headStyles: {
        fillColor: [30, 41, 59],
        textColor: [255, 255, 255]
      },
      margin: {
        top,
        left: 24,
        right: 24,
        bottom: 68
      },
      didDrawPage: () => {
        doc.setTextColor(30, 41, 59);
        doc.setFontSize(13);
        doc.text(heading, 24, 23);
        doc.setTextColor(71, 85, 105);
        doc.setFontSize(7);
        getExportMetadata().forEach((line, index) => doc.text(doc.splitTextToSize(line, width - 48), 24, height - 45 + index * 11));
      }
    });
    doc.save(`${sanitizeFilename(filename)}.pdf`);
  },
  toPNG: ExportData.png
};
const exportMasterColumns = [{
  header: "CONTRATO/COMPRA",
  key: "contrato"
}, ...ContractFiles.exportColumns(), {
  header: "SITUAÇÃO",
  key: "situacao"
}, {
  header: "FORNECEDOR",
  key: "fornecedor"
}, {
  header: "OBJETO",
  key: "objeto"
}, {
  header: "GESTOR",
  key: "gestor"
}, {
  header: "FISCAL",
  key: "fiscal"
}, {
  header: "COMPRA",
  key: "compra"
}, {
  header: "MODALIDADE",
  key: "modalidade"
}, {
  header: "INÍCIO",
  key: "data_inic"
}, {
  header: "FIM",
  key: "data_fim"
}, {
  header: "% TEMPO",
  key: "perc_tempo",
  isPercent: true
}, {
  header: "PASSARAM",
  key: "dias_passaram"
}, {
  header: "FALTAM",
  key: "encerrando_dias"
}, {
  header: "GLOBAL-EMP",
  key: "dif_global",
  isCurrency: true
}, {
  header: "GLOBAL",
  key: "v_global",
  isCurrency: true
}, {
  header: "EMPENHADO",
  key: "v_empenhado",
  isCurrency: true
}, {
  header: "RECEBIDO",
  key: "v_recebido",
  isCurrency: true
}, {
  header: "RCB %",
  key: "p_recebido",
  isPercent: true
}, {
  header: "LIQUIDADO",
  key: "v_liquidado",
  isCurrency: true
}, {
  header: "LIQ %",
  key: "p_liquidado",
  isPercent: true
}, {
  header: "A LIQUIDAR",
  key: "v_a_liquidar",
  isCurrency: true
}, {
  header: "A LIQ %",
  key: "p_a_liquidar",
  isPercent: true
}, {
  header: "PAGO",
  key: "v_pago",
  isCurrency: true
}, {
  header: "PAGO %",
  key: "p_pago",
  isPercent: true
}, {
  header: "A PAGAR",
  key: "v_a_pagar",
  isCurrency: true
}, {
  header: "A PAGAR %",
  key: "p_a_pagar",
  isPercent: true
}, {
  header: "BLOQUEADO",
  key: "v_bloqueado",
  isCurrency: true
}, {
  header: "BLOQ %",
  key: "p_bloqueado",
  isPercent: true
}, {
  header: "CANCELADO",
  key: "v_cancelado",
  isCurrency: true
}, {
  header: "CANC %",
  key: "p_cancelado",
  isPercent: true
}, {
  header: "EXECUTADO",
  key: "v_executado",
  isCurrency: true
}, {
  header: "EXEC %",
  key: "p_executado",
  isPercent: true
}, {
  header: "EXEC LIQ",
  key: "v_pago",
  isCurrency: true
}, {
  header: "EXEC LIQ %",
  key: "p_pago",
  isPercent: true
}];
const tooltipCallback = {
  callbacks: {
    label: function (context) {
      let label = context.dataset.label || '';
      if (label) label += ': ';
      if (label.includes('QTD') || label.includes('Quantidade') || label.includes('Contratos')) {
        label += context.raw.toLocaleString('pt-BR');
      } else {
        label += formatBRL(context.raw);
      }
      return label;
    }
  }
};
const getFullTooltipFornecedor = dataArray => ({
  callbacks: {
    title: function (tooltipItems) {
      return dataArray[tooltipItems[0].dataIndex].label || dataArray[tooltipItems[0].dataIndex].contrato;
    },
    beforeBody: function (tooltipItems) {
      const item = dataArray[tooltipItems[0].dataIndex];
      if (!item.objetos) return '';
      const mods = Array.from(item.modalidades).join(', ');
      const objs = Array.from(item.objetos).join(' | ');
      return `Modalidade(s): ${mods}\nObjeto(s):\n${formatLabelMultiLine(objs, 60).join('\n')}`;
    },
    label: function (context) {
      let label = context.dataset.label || '';
      if (label) label += ': ';
      if (label.includes('QTD') || label.includes('Quantidade')) label += context.raw.toLocaleString('pt-BR');else label += formatBRL(context.raw);
      return label;
    }
  }
});
const getFullTooltipContrato = dataArray => ({
  callbacks: {
    title: function (tooltipItems) {
      const idx = tooltipItems[0].dataIndex;
      return `Contrato: ${dataArray[idx].contrato}`;
    },
    beforeBody: function (tooltipItems) {
      const idx = tooltipItems[0].dataIndex;
      const item = dataArray[idx];
      const objFormatado = formatLabelMultiLine(item.objeto, 60).join('\n');
      return `Fornecedor: ${item.fornecedor}\nObjeto:\n${objFormatado}`;
    },
    label: function (context) {
      let label = context.dataset.label || '';
      if (label) label += ': ';
      const idx = context.dataIndex;
      const item = dataArray[idx];
      if (context.dataset.yAxisID === 'y_perc' || label.includes('%')) {
        label += formatPercentBR(context.raw);
        if (context.dataset.label === '% Tempo') {
          const dias = item.encerrando_dias !== null ? `${item.encerrando_dias} d` : '-';
          label += ` (Faltam: ${dias})`;
        } else if (context.dataset.label === '% Recebido') {
          label += ` (${formatBRL(item.v_recebido)})`;
        } else if (context.dataset.label === '% Liquidado') {
          label += ` (${formatBRL(item.v_liquidado)})`;
        } else if (context.dataset.label === '% Pago') {
          label += ` (${formatBRL(item.v_pago)})`;
        }
      } else {
        label += formatBRL(context.raw);
        if (context.dataset.label === 'Valor Empenhado') {
          label += `\nGlobal: ${formatBRL(item.v_global)}`;
        }
      }
      return label;
    }
  }
});
const getBubbleTooltip = () => ({
  callbacks: {
    title: function (tooltipItems) {
      return `Contrato: ${tooltipItems[0].raw.contrato}`;
    },
    label: function (context) {
      const d = context.raw;
      const percentOfCommitted = value => d.v_empenhado ? formatPercentBR(value / d.v_empenhado) : '0,0%';
      return [`Objeto: ${d.objeto}`, `Fornecedor: ${d.fornecedor}`, `Situação: ${d.situacao}`, `Empenhado: ${formatBRL(d.v_empenhado)}`, `Recebido: ${formatBRL(d.v_recebido)} (${percentOfCommitted(d.v_recebido)})`, `Liquidado: ${formatBRL(d.v_liquidado)} (${percentOfCommitted(d.v_liquidado)})`, `Pago: ${formatBRL(d.v_pago)} (${percentOfCommitted(d.v_pago)})`, `Tempo: ${Math.max(0, d.dias_passaram || 0).toLocaleString('pt-BR')} dias de ${Math.max(0, d.duracao_total_dias || 0).toLocaleString('pt-BR')} (${formatPercentBR(d.perc_tempo)})`];
    }
  }
});
const startResize = e => {
  const th = e.target.closest('th');
  const table = th === null || th === void 0 ? void 0 : th.closest('table');
  if (!th || !table) return;
  const startX = e.pageX;
  const startWidth = th.getBoundingClientRect().width;
  const columnIndex = th.cellIndex;
  const columnCells = Array.from(table.querySelectorAll('thead tr, tbody tr, tfoot tr')).map(row => Array.from(row.cells).find(cell => cell.cellIndex === columnIndex && cell.colSpan === 1)).filter(Boolean);
  th.dataset.userSized = 'true';
  document.body.style.userSelect = 'none';
  const onMouseMove = moveEvent => {
    const width = Math.max(40, startWidth + moveEvent.pageX - startX);
    columnCells.forEach(cell => {
      cell.style.width = `${width}px`;
      cell.style.minWidth = '40px';
      cell.style.maxWidth = `${width}px`;
      cell.style.whiteSpace = 'normal';
      cell.style.overflowWrap = 'anywhere';
    });
  };
  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = '';
  };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
};
function AutoFitText(_ref23) {
  let {
    text,
    className
  } = _ref23;
  const containerRef = useRef(null);
  const textRef = useRef(null);
  useEffect(() => {
    const resize = () => {
      if (containerRef.current && textRef.current) {
        textRef.current.style.transform = 'none';
        const containerWidth = containerRef.current.clientWidth;
        const textWidth = textRef.current.scrollWidth;
        if (textWidth > containerWidth && containerWidth > 0) {
          const scale = containerWidth / textWidth;
          textRef.current.style.transform = `scale(${scale})`;
        }
      }
    };
    resize();
    setTimeout(resize, 50);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [text]);
  return /*#__PURE__*/React.createElement("div", {
    ref: containerRef,
    className: "w-full overflow-hidden flex items-center"
  }, /*#__PURE__*/React.createElement("div", {
    ref: textRef,
    className: `${className} origin-left whitespace-nowrap inline-block`
  }, text));
}
const ChartComponent = _ref24 => {
  let {
    type,
    data,
    options,
    id,
    exportTitle,
    exportRows,
    exportColumns,
    exportPercentUnit,
    hideExportActions = false
  } = _ref24;
  const coloredData = useMemo(() => MetricColors.chartData(data, type), [data, type]);
  const canvasRef = useRef(null),
    chartInstance = useRef(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartInstance.current) chartInstance.current.destroy();
    chartInstance.current = new Chart(canvasRef.current.getContext('2d'), {
      type,
      data: coloredData,
      options
    });
    return () => {
      if (chartInstance.current) chartInstance.current.destroy();
    };
  }, [coloredData, options, type]);
  const title = () => {
    var _canvasRef$current;
    return exportTitle || ((_canvasRef$current = canvasRef.current) === null || _canvasRef$current === void 0 || (_canvasRef$current = _canvasRef$current.closest('.bg-white')) === null || _canvasRef$current === void 0 || (_canvasRef$current = _canvasRef$current.querySelector('h3')) === null || _canvasRef$current === void 0 || (_canvasRef$current = _canvasRef$current.textContent) === null || _canvasRef$current === void 0 ? void 0 : _canvasRef$current.trim()) || id || 'Gráfico';
  };
  const handlePngExport = () => exportTable.toPNG(canvasRef.current, title(), title(), {
    type,
    data: coloredData,
    options,
    exportId: id
  }, chartInstance.current);
  const handleTableExport = format => {
    const result = exportRows && exportColumns ? {
      rows: exportRows,
      columns: exportColumns
    } : ExportData.chartRows(data, type, chartInstance.current, exportPercentUnit, id);
    if (format === 'excel') exportTable.toExcel(result.rows, title(), result.columns);else if (format === 'csv') exportTable.toCSV(result.rows, title(), result.columns);else exportTable.toPDF(result.rows, title(), result.columns, title());
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "chart-export-host relative w-full h-full"
  }, !hideExportActions && /*#__PURE__*/React.createElement("div", {
    className: "chart-export-actions absolute right-1 top-1 z-20 flex gap-1",
    "aria-label": "Exportar gr\xE1fico e dados"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: handlePngExport,
    className: "rounded bg-slate-800/90 px-2 py-1 text-[8px] font-black text-white shadow hover:bg-slate-700",
    title: "Exportar gr\xE1fico completo em PNG"
  }, "PNG"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => handleTableExport('excel'),
    className: "rounded bg-green-600/90 px-2 py-1 text-[8px] font-black text-white shadow hover:bg-green-500",
    title: "Exportar todos os dados exibidos para Excel"
  }, "EXCEL"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => handleTableExport('csv'),
    className: "rounded bg-blue-600/90 px-2 py-1 text-[8px] font-black text-white shadow hover:bg-blue-500",
    title: "Exportar todos os dados exibidos para CSV"
  }, "CSV"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => handleTableExport('pdf'),
    className: "rounded bg-red-600/90 px-2 py-1 text-[8px] font-black text-white shadow hover:bg-red-500",
    title: "Exportar todos os dados exibidos para PDF"
  }, "PDF")), /*#__PURE__*/React.createElement("canvas", {
    id: id,
    ref: canvasRef
  }));
};

// Componente: alterna entre Pizza, Barras e Tabela com seletor financeiro.
function ToggleableChartCard(_ref25) {
  var _title$match;
  let {
    title,
    data,
    isFinancial,
    id,
    isFornecedor,
    subjectLabel: subjectLabelProp
  } = _ref25;
  const [viewMode, setViewMode] = useState('pie');
  const [finMetric, setFinMetric] = useState('total');
  const [tableSort, setTableSort] = useState({
    field: 'value',
    direction: 'desc'
  });
  const activeMetric = isFinancial ? finMetric : 'count';
  const sortedData = useMemo(() => {
    let processed = data.map(item => ({
      ...item,
      fullLabel: item.fullLabel || item.label
    }));
    if (isFornecedor) {
      processed = processed.map(d => ({
        ...d,
        label: d.label.replace(/^[\d\.\-\/]+\s*-\s*/, '')
      }));
    }

    // Sorting by chosen dynamic metric
    processed.sort((a, b) => (b[activeMetric] || 0) - (a[activeMetric] || 0) || String(a.label).localeCompare(String(b.label), 'pt-BR'));
    return processed;
  }, [data, isFornecedor, activeMetric]);
  const chartData = useMemo(() => {
    if (sortedData.length <= 10) return sortedData;
    const top9 = sortedData.slice(0, 9);
    const others = sortedData.slice(9).reduce((acc, curr) => {
      acc.count += curr.count || 0;
      acc.total += curr.total || 0;
      acc.recebido += curr.recebido || 0;
      acc.a_receber += curr.a_receber || 0;
      acc.liquidado += curr.liquidado || 0;
      acc.a_liquidar += curr.a_liquidar || 0;
      acc.pago += curr.pago || 0;
      acc.a_pagar += curr.a_pagar || 0;
      acc.bloqueado += curr.bloqueado || 0;
      acc.cancelado += curr.cancelado || 0;
      acc.executado += curr.executado || 0;
      return acc;
    }, {
      label: "OUTROS",
      fullLabel: "OUTROS",
      count: 0,
      total: 0,
      recebido: 0,
      a_receber: 0,
      liquidado: 0,
      a_liquidar: 0,
      pago: 0,
      a_pagar: 0,
      bloqueado: 0,
      cancelado: 0,
      executado: 0
    });
    return [...top9, others];
  }, [sortedData]);
  const chartLabels = chartData.map(d => formatLabelMultiLine(d.label, 15));
  const displayedValues = sortedData.map(d => d[activeMetric] || 0);
  const displayedTotal = displayedValues.reduce((sum, value) => sum + value, 0);
  const totalCount = sortedData.reduce((sum, item) => sum + (item.count || 0), 0);
  const totalValue = sortedData.reduce((sum, item) => sum + (isFinancial ? item[activeMetric] || 0 : item.total || 0), 0);
  const metricNames = {
    'total': 'Empenhado',
    'recebido': 'Recebido',
    'a_receber': 'A Receber',
    'liquidado': 'Liquidado',
    'a_liquidar': 'A Liquidar',
    'pago': 'Pago (Exec Líq)',
    'a_pagar': 'A Pagar',
    'bloqueado': 'Bloqueado',
    'cancelado': 'Cancelado',
    'executado': 'Executado',
    'count': 'QTD Contratos'
  };
  const currentMetricName = metricNames[activeMetric];
  const displayTitle = isFinancial ? title.replace(/Empenhado/i, currentMetricName) : title;
  const subjectToken = ((_title$match = title.match(/\(([^)]+)\)/)) === null || _title$match === void 0 || (_title$match = _title$match[1]) === null || _title$match === void 0 ? void 0 : _title$match.trim().toUpperCase()) || 'ASSUNTO';
  const subjectNames = {
    'MOD': 'MODALIDADE',
    'SEC': 'SEC LOG',
    'NR COMPRA': 'COMPRA',
    'FORNECEDOR': 'FORNECEDOR',
    'ANO VIG INI': 'ANO VIG INI',
    'SITUAÇÃO': 'SITUAÇÃO',
    'AO CÓDIGO': 'AO CÓDIGO',
    'PO CÓDIGO': 'PO CÓDIGO',
    'ND CÓDIGO': 'ND CÓDIGO'
  };
  const subjectLabel = subjectLabelProp || subjectNames[subjectToken] || subjectToken;
  const tableRows = useMemo(() => {
    const rows = sortedData.map(item => {
      const value = isFinancial ? item[activeMetric] || 0 : item.total || 0;
      return {
        ...item,
        subject: item.label,
        quantity: item.count || 0,
        pct_quantity: totalCount ? (item.count || 0) / totalCount : 0,
        value,
        pct_value: totalValue ? value / totalValue : 0
      };
    });
    const direction = tableSort.direction === 'asc' ? 1 : -1;
    return rows.sort((a, b) => {
      if (tableSort.field === 'subject') return direction * String(a.subject).localeCompare(String(b.subject), 'pt-BR');
      return direction * ((a[tableSort.field] || 0) - (b[tableSort.field] || 0));
    });
  }, [sortedData, isFinancial, activeMetric, totalCount, totalValue, tableSort]);
  const tableExportColumns = [{
    header: subjectLabel,
    key: 'subject'
  }, {
    header: 'QUANTIDADE',
    key: 'quantity'
  }, {
    header: '% QTD',
    key: 'pct_quantity',
    isPercent: true
  }, {
    header: 'VALOR',
    key: 'value',
    isCurrency: true
  }, {
    header: '% VALOR',
    key: 'pct_value',
    isPercent: true
  }];
  const handleTableSort = field => setTableSort(previous => ({
    field,
    direction: previous.field === field && previous.direction === 'asc' ? 'desc' : 'asc'
  }));
  const sortMark = field => tableSort.field === field ? tableSort.direction === 'asc' ? ' ▲' : ' ▼' : '';
  const pieData = {
    labels: chartData.map(d => d.label),
    datasets: [{
      label: isFinancial ? currentMetricName : 'QTD Contratos',
      data: chartData.map(d => d[activeMetric]),
      borderWidth: 1,
      borderColor: '#ffffff'
    }]
  };
  const pieOptions = {
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: {
        top: 20,
        left: 30,
        right: 30,
        bottom: 5
      }
    },
    plugins: {
      tooltip: {
        callbacks: {
          title: function (context) {
            var _context$;
            return ((_context$ = context[0]) === null || _context$ === void 0 ? void 0 : _context$.label) || '';
          },
          label: function (context) {
            const item = chartData[context.dataIndex];
            const value = isFinancial ? item[activeMetric] || 0 : item.total || 0;
            const shareBase = isFinancial ? displayedTotal : totalCount;
            const shareValue = isFinancial ? item[activeMetric] || 0 : item.count || 0;
            return [`Valor: ${formatBRL(value)}`, `Quantidade: ${(item.count || 0).toLocaleString('pt-BR')}`, `Porcentagem: ${shareBase ? formatPercentBR(shareValue / shareBase) : '0,00%'}`];
          }
        }
      },
      legend: {
        position: 'bottom',
        align: 'center',
        labels: {
          boxWidth: chartData.length > 6 ? 6 : 10,
          padding: chartData.length > 6 ? 8 : 12,
          font: {
            size: chartData.length > 6 ? 8 : 10
          },
          generateLabels: function (chart) {
            const data = chart.data;
            if (data.labels.length && data.datasets.length) {
              return data.labels.map(function (label, i) {
                const meta = chart.getDatasetMeta(0);
                const style = meta.controller.getStyle(i);
                const maxLen = data.labels.length > 6 ? 12 : 18;
                return {
                  text: label.length > maxLen ? label.substring(0, maxLen) + '...' : label,
                  fillStyle: style.backgroundColor,
                  strokeStyle: style.borderColor,
                  lineWidth: style.borderWidth,
                  hidden: isNaN(data.datasets[0].data[i]) || meta.data[i].hidden,
                  index: i
                };
              });
            }
            return [];
          }
        }
      },
      datalabels: {
        display: true,
        color: '#334155',
        align: 'end',
        anchor: 'end',
        offset: 20,
        textAlign: 'center',
        font: context => {
          const dataArr = context.chart.data.datasets[0].data;
          const val = context.dataset.data[context.dataIndex];
          const total = dataArr.reduce((a, b) => a + b, 0);
          const percentage = total ? val * 100 / total : 0;
          return {
            weight: 'bold',
            size: percentage < 4 ? 7 : percentage < 10 ? 8 : 9
          };
        },
        formatter: (value, context) => {
          const dataArr = context.chart.data.datasets[0].data;
          const total = dataArr.reduce((a, b) => a + b, 0);
          if (!total || value === 0) return '';
          const percentage = value * 100 / total;
          const valStr = isFinancial ? shortenNumber(value) : value.toLocaleString('pt-BR');
          return `${percentage.toFixed(1).replace('.', ',')}%\n${valStr}`;
        }
      }
    }
  };
  const barData = {
    labels: chartLabels,
    datasets: [{
      label: isFinancial ? currentMetricName : 'Quantidade',
      data: chartData.map(d => d[activeMetric]),
      backgroundColor: chartData.map((d, i) => d.label.trim() === 'OUTROS' ? '#94a3b8' : isFinancial ? '#3b82f6' : '#f97316'),
      borderRadius: 4
    }]
  };
  const barOptions = {
    indexAxis: 'x',
    responsive: true,
    maintainAspectRatio: false,
    layout: {
      padding: {
        top: 30
      }
    },
    plugins: {
      tooltip: {
        callbacks: {
          title: function (context) {
            var _chartData$context$0$, _context$2;
            return ((_chartData$context$0$ = chartData[(_context$2 = context[0]) === null || _context$2 === void 0 ? void 0 : _context$2.dataIndex]) === null || _chartData$context$0$ === void 0 ? void 0 : _chartData$context$0$.label) || '';
          },
          label: function (context) {
            const item = chartData[context.dataIndex];
            const value = isFinancial ? item[activeMetric] || 0 : item.total || 0;
            const shareBase = isFinancial ? displayedTotal : totalCount;
            const shareValue = isFinancial ? item[activeMetric] || 0 : item.count || 0;
            return [`Valor: ${formatBRL(value)}`, `Quantidade: ${(item.count || 0).toLocaleString('pt-BR')}`, `Porcentagem: ${shareBase ? formatPercentBR(shareValue / shareBase) : '0,00%'}`];
          }
        }
      },
      legend: {
        display: false
      },
      datalabels: {
        display: function (context) {
          return context.dataset.data[context.dataIndex] > 0;
        },
        color: '#1e293b',
        align: 'end',
        anchor: 'end',
        rotation: -90,
        offset: 4,
        font: {
          size: 9,
          weight: 'bold'
        },
        formatter: v => isFinancial ? shortenNumber(v) : v.toLocaleString('pt-BR')
      }
    },
    scales: {
      x: {
        ticks: {
          maxRotation: 90,
          minRotation: 45,
          font: {
            size: 9
          },
          autoSkip: false,
          callback: function (value) {
            const label = this.getLabelForValue(value);
            if (Array.isArray(label)) {
              return label.map(l => l.length > 15 ? l.substring(0, 15) + '...' : l);
            }
            return label.length > 15 ? label.substring(0, 15) + '...' : label;
          }
        }
      },
      y: {
        beginAtZero: true,
        grace: '10%',
        position: 'left',
        grid: {
          display: true
        },
        ticks: {
          callback: v => isFinancial ? shortenNumber(v) : v
        },
        title: {
          display: true,
          text: isFinancial ? `Valor ${currentMetricName} (R$)` : 'Quantidade',
          font: {
            size: 9,
            weight: 'bold'
          }
        }
      }
    }
  };
  const nextViewMode = viewMode === 'pie' ? 'bar' : viewMode === 'bar' ? 'table' : 'pie';
  const nextViewLabel = viewMode === 'pie' ? '► BARRAS' : viewMode === 'bar' ? '▦ TABELA' : '◉ PIZZA';
  const currentViewLabel = viewMode === 'pie' ? 'Fatias' : viewMode === 'bar' ? 'Barras' : 'Linhas';
  return /*#__PURE__*/React.createElement("div", {
    className: "bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full hover:shadow-md transition"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap justify-between items-start gap-2 mb-4 border-b border-slate-100 pb-3"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-[10px] font-black text-slate-800 uppercase tracking-tight min-w-0 flex-1 pr-2",
    "data-metric": isFinancial ? MetricColors.key(activeMetric) : undefined,
    style: isFinancial ? MetricColors.textStyle(activeMetric) : undefined
  }, displayTitle), /*#__PURE__*/React.createElement("div", {
    className: "flex max-w-full flex-wrap gap-2 items-center"
  }, isFinancial && /*#__PURE__*/React.createElement("select", {
    value: finMetric,
    onChange: e => setFinMetric(e.target.value),
    className: "text-[9px] font-bold uppercase border border-slate-300 bg-slate-50 rounded px-2 py-1 outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: "total"
  }, "Empenhado"), /*#__PURE__*/React.createElement("option", {
    value: "recebido"
  }, "Recebido"), /*#__PURE__*/React.createElement("option", {
    value: "a_receber"
  }, "A Receber"), /*#__PURE__*/React.createElement("option", {
    value: "liquidado"
  }, "Liquidado"), /*#__PURE__*/React.createElement("option", {
    value: "a_liquidar"
  }, "A Liquidar"), /*#__PURE__*/React.createElement("option", {
    value: "pago"
  }, "Pago / Exec L\xEDq"), /*#__PURE__*/React.createElement("option", {
    value: "a_pagar"
  }, "A Pagar"), /*#__PURE__*/React.createElement("option", {
    value: "cancelado"
  }, "Cancelado"), /*#__PURE__*/React.createElement("option", {
    value: "bloqueado"
  }, "Bloqueado"), /*#__PURE__*/React.createElement("option", {
    value: "executado"
  }, "Executado")), /*#__PURE__*/React.createElement("span", {
    className: "text-[9px] font-black bg-slate-100 text-slate-500 px-2 py-1 rounded hidden sm:inline-block"
  }, currentViewLabel, ": ", viewMode === 'table' ? tableRows.length : chartData.length), /*#__PURE__*/React.createElement("button", {
    onClick: () => setViewMode(nextViewMode),
    className: "text-[9px] font-black uppercase tracking-widest bg-blue-50 text-blue-600 px-2 py-1 rounded border border-blue-200 hover:bg-blue-100 transition shadow-sm cursor-pointer"
  }, nextViewLabel))), viewMode === 'pie' && /*#__PURE__*/React.createElement("div", {
    className: "mb-3 flex items-center justify-center gap-2 text-[8px] font-bold text-slate-500",
    title: "As fatias menores usam cores frias e as maiores usam cores quentes. Valores iguais recebem a mesma cor. Outros segue a mesma regra, pelo valor somado."
  }, /*#__PURE__*/React.createElement("span", null, "Menor valor \xB7 frio"), /*#__PURE__*/React.createElement("span", {
    className: "h-2 w-20 rounded-full",
    style: {
      background: MetricColors.thermalGradient
    },
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("span", null, "Maior valor \xB7 quente")), /*#__PURE__*/React.createElement("div", {
    className: "w-full flex-1 flex flex-col min-h-[300px] relative"
  }, viewMode === 'table' ? /*#__PURE__*/React.createElement("div", {
    className: "absolute inset-0 flex flex-col overflow-hidden rounded-lg border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex shrink-0 justify-end gap-2 border-b border-slate-200 bg-slate-800 p-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toExcel(tableRows, `${id}_${currentMetricName}`, tableExportColumns),
    className: "rounded bg-green-600 px-3 py-1 text-[9px] font-black text-white hover:bg-green-500"
  }, "EXCEL"), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toCSV(tableRows, `${id}_${currentMetricName}`, tableExportColumns),
    className: "rounded bg-blue-600 px-3 py-1 text-[9px] font-black text-white hover:bg-blue-500"
  }, "CSV"), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toPDF(tableRows, `${id}_${currentMetricName}`, tableExportColumns, displayTitle),
    className: "rounded bg-red-600 px-3 py-1 text-[9px] font-black text-white hover:bg-red-500"
  }, "PDF")), /*#__PURE__*/React.createElement("div", {
    className: "min-h-0 flex-1 overflow-auto"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full text-[10px]"
  }, /*#__PURE__*/React.createElement("thead", {
    className: "sticky top-0 bg-slate-100 text-slate-700 uppercase"
  }, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    className: "p-2 text-left"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => handleTableSort('subject'),
    className: "w-full text-left font-black",
    title: "Ordenar crescente/decrescente"
  }, subjectLabel, sortMark('subject'))), /*#__PURE__*/React.createElement("th", {
    className: "p-2 text-right"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => handleTableSort('quantity'),
    className: "w-full text-right font-black",
    title: "Ordenar crescente/decrescente"
  }, "Quantidade", sortMark('quantity'))), /*#__PURE__*/React.createElement("th", {
    className: "p-2 text-right"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => handleTableSort('pct_quantity'),
    className: "w-full text-right font-black",
    title: "Ordenar crescente/decrescente"
  }, "% QTD", sortMark('pct_quantity'))), /*#__PURE__*/React.createElement("th", {
    className: "p-2 text-right"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => handleTableSort('value'),
    className: "w-full text-right font-black",
    title: "Ordenar crescente/decrescente"
  }, "Valor", sortMark('value'))), /*#__PURE__*/React.createElement("th", {
    className: "p-2 text-right"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => handleTableSort('pct_value'),
    className: "w-full text-right font-black",
    title: "Ordenar crescente/decrescente"
  }, "% Valor", sortMark('pct_value'))))), /*#__PURE__*/React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, tableRows.map((item, index) => /*#__PURE__*/React.createElement("tr", {
    key: `${id}-table-${index}`,
    className: "hover:bg-blue-50"
  }, /*#__PURE__*/React.createElement("td", {
    className: "p-2 font-bold text-slate-700 break-words",
    title: item.tooltip || item.fullLabel || item.subject
  }, item.subject), /*#__PURE__*/React.createElement("td", {
    className: "p-2 text-right tabular-nums"
  }, item.quantity.toLocaleString('pt-BR')), /*#__PURE__*/React.createElement("td", {
    className: "p-2 text-right tabular-nums"
  }, formatPercentBR(item.pct_quantity)), /*#__PURE__*/React.createElement("td", {
    className: "p-2 text-right tabular-nums font-bold",
    "data-metric": isFinancial ? MetricColors.key(activeMetric) : undefined,
    style: isFinancial ? MetricColors.textStyle(activeMetric) : undefined
  }, formatBRL(item.value)), /*#__PURE__*/React.createElement("td", {
    className: "p-2 text-right tabular-nums",
    "data-metric": isFinancial ? MetricColors.key(activeMetric) : undefined,
    style: isFinancial ? MetricColors.textStyle(activeMetric) : undefined
  }, formatPercentBR(item.pct_value)))))))) : /*#__PURE__*/React.createElement("div", {
    className: "absolute inset-0"
  }, viewMode === 'pie' ? /*#__PURE__*/React.createElement(ChartComponent, {
    id: `pie-${id}`,
    type: "pie",
    data: pieData,
    options: pieOptions,
    exportTitle: displayTitle
  }) : /*#__PURE__*/React.createElement(ChartComponent, {
    id: `bar-${id}`,
    type: "bar",
    data: barData,
    options: barOptions,
    exportTitle: displayTitle
  }))));
}
function ChartTableToggle(_ref26) {
  let {
    isTable,
    onToggle
  } = _ref26;
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onToggle,
    className: "rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-blue-600 shadow-sm transition hover:bg-blue-100"
  }, isTable ? '▥ GRÁFICO' : '▦ TABELA');
}
function SortableChartTable(_ref27) {
  var _columns$;
  let {
    id,
    title,
    rows,
    columns,
    initialSortKey
  } = _ref27;
  const [sort, setSort] = useState({
    key: initialSortKey || ((_columns$ = columns[0]) === null || _columns$ === void 0 ? void 0 : _columns$.key),
    direction: 'desc'
  });
  const sortedRows = useMemo(() => {
    const column = columns.find(item => item.key === sort.key) || columns[0];
    const direction = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const valueA = column !== null && column !== void 0 && column.sortValue ? column.sortValue(a) : a[column === null || column === void 0 ? void 0 : column.key];
      const valueB = column !== null && column !== void 0 && column.sortValue ? column.sortValue(b) : b[column === null || column === void 0 ? void 0 : column.key];
      if (typeof valueA === 'number' || typeof valueB === 'number') return direction * ((Number(valueA) || 0) - (Number(valueB) || 0));
      return direction * String(valueA || '').localeCompare(String(valueB || ''), 'pt-BR');
    });
  }, [rows, columns, sort]);
  const toggleSort = key => setSort(previous => ({
    key,
    direction: previous.key === key && previous.direction === 'asc' ? 'desc' : 'asc'
  }));
  const sortMark = key => sort.key === key ? sort.direction === 'asc' ? ' ▲' : ' ▼' : '';
  const displayValue = (row, column) => {
    if (column.render) return column.render(row);
    const value = column.format ? column.format(row) : row[column.key];
    if (value === null || value === undefined || value === '') return '-';
    if (column.isCurrency) return formatBRL(value);
    if (column.isPercent) return formatPercentBR(value);
    if (typeof value === 'number') return value.toLocaleString('pt-BR');
    return /*#__PURE__*/React.createElement(PortalDocumentTableValue, {
      value: value,
      row: row,
      field: column.key
    });
  };
  const exportColumns = columns.map(_ref28 => {
    let {
      render,
      sortValue,
      ...column
    } = _ref28;
    return column;
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "flex h-full min-h-[300px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex shrink-0 flex-wrap justify-end gap-2 border-b border-slate-200 bg-slate-800 p-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toExcel(sortedRows, id, exportColumns),
    className: "rounded bg-green-600 px-3 py-1 text-[9px] font-black text-white hover:bg-green-500"
  }, "EXCEL"), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toCSV(sortedRows, id, exportColumns),
    className: "rounded bg-blue-600 px-3 py-1 text-[9px] font-black text-white hover:bg-blue-500"
  }, "CSV"), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toPDF(sortedRows, id, exportColumns, title),
    className: "rounded bg-red-600 px-3 py-1 text-[9px] font-black text-white hover:bg-red-500"
  }, "PDF")), /*#__PURE__*/React.createElement("div", {
    className: "min-h-0 flex-1 overflow-auto"
  }, /*#__PURE__*/React.createElement("table", {
    className: "w-full border-collapse text-[10px]"
  }, /*#__PURE__*/React.createElement("thead", {
    className: "sticky top-0 z-10 bg-slate-100 text-slate-700 uppercase shadow-sm"
  }, /*#__PURE__*/React.createElement("tr", null, columns.map(column => /*#__PURE__*/React.createElement("th", {
    key: column.key,
    "data-metric": MetricColors.key(column.key),
    style: MetricColors.textStyle(column.key),
    className: `whitespace-nowrap p-2 ${column.align === 'left' ? 'text-left' : 'text-right'}`
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => toggleSort(column.key),
    className: `w-full font-black ${column.align === 'left' ? 'text-left' : 'text-right'}`,
    title: "Ordenar crescente/decrescente"
  }, column.header, sortMark(column.key)))))), /*#__PURE__*/React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, sortedRows.map((row, rowIndex) => /*#__PURE__*/React.createElement("tr", {
    key: `${id}-row-${rowIndex}`,
    className: "hover:bg-blue-50"
  }, columns.map((column, columnIndex) => /*#__PURE__*/React.createElement("td", {
    key: column.key,
    "data-metric": MetricColors.key(column.key),
    style: MetricColors.textStyle(column.key),
    className: `p-2 tabular-nums ${columnIndex === 0 || column.align === 'left' ? 'text-left' : 'text-right'} ${columnIndex === 0 ? 'font-bold text-slate-700' : ''}`,
    title: columnIndex === 0 ? row._tooltip || String(row[column.key] || '') : undefined
  }, displayValue(row, column)))))))));
}
function KPICard(_ref29) {
  let {
    title,
    value,
    subValue,
    diffValue,
    diffLabel,
    extraText,
    color,
    isCurrency,
    subLabel = "do Empenhado"
  } = _ref29;
  const colors = {
    slate: "border-slate-800 text-slate-800",
    blue: "border-blue-500 text-blue-700",
    amber: "border-amber-500 text-amber-600",
    emerald: "border-emerald-500 text-emerald-600",
    violet: "border-violet-500 text-violet-700",
    red: "border-red-500 text-red-600",
    orange: "border-orange-500 text-orange-600",
    teal: "border-teal-500 text-teal-700",
    cyan: "border-cyan-500 text-cyan-700"
  };
  const mainText = isCurrency ? formatBRL(value) : value.toLocaleString('pt-BR');
  const renderExtraText = () => {
    if (!extraText) return null;
    const lines = extraText.split('\n');
    return /*#__PURE__*/React.createElement("div", {
      className: "text-[9.5px] font-bold text-slate-500 mt-2 leading-[1.1] border-t border-slate-100 pt-1"
    }, lines.map((line, idx) => /*#__PURE__*/React.createElement("div", {
      key: idx
    }, line)));
  };
  return /*#__PURE__*/React.createElement("div", {
    className: `bg-white p-3 sm:p-5 rounded-2xl border-t-8 shadow-md flex flex-col justify-start overflow-hidden min-w-0 ${colors[color]}`,
    "data-metric": isCurrency ? MetricColors.key(title) : undefined,
    style: isCurrency ? MetricColors.cardStyle(title) : undefined
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-[10px] font-black uppercase tracking-widest opacity-50 mb-1 truncate",
    title: title
  }, title), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col w-full min-w-0"
  }, /*#__PURE__*/React.createElement(AutoFitText, {
    text: mainText,
    className: "font-black text-2xl tracking-tight"
  }), diffValue !== undefined && /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold text-red-500 mt-1 leading-tight break-words",
    title: `${diffLabel}: ${formatBRL(diffValue)}`
  }, diffLabel, ": ", formatBRL(diffValue)), subValue !== undefined && /*#__PURE__*/React.createElement("span", {
    className: "text-[10px] font-bold opacity-70 mt-1"
  }, formatPercentBR(subValue), " ", subLabel), renderExtraText()));
}
function TextHeader(_ref30) {
  let {
    label,
    field,
    current,
    onSort,
    align = "left",
    searchVal,
    onSearchChange,
    widthClass
  } = _ref30;
  const isSorted = current.key === field;
  return /*#__PURE__*/React.createElement("th", {
    className: `p-2 transition text-${align} bg-slate-50 relative group ${widthClass || 'w-auto'}`
  }, /*#__PURE__*/React.createElement("div", {
    onMouseDown: startResize,
    className: "absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize bg-transparent hover:bg-blue-400 z-20"
  }), /*#__PURE__*/React.createElement("div", {
    className: `flex items-center gap-1 cursor-pointer hover:text-blue-500 justify-${align === 'right' ? 'end' : align === 'center' ? 'center' : 'start'}`,
    onClick: () => onSort(field)
  }, label, " ", /*#__PURE__*/React.createElement("span", {
    className: "text-[8px] text-slate-400"
  }, isSorted ? current.direction === 'asc' ? '▲' : '▼' : '↕')), onSearchChange !== undefined && /*#__PURE__*/React.createElement("input", {
    type: "text",
    placeholder: "Buscar...",
    value: searchVal,
    onChange: e => onSearchChange(e.target.value),
    onClick: e => e.stopPropagation(),
    className: "mt-2 w-full px-1 py-1 text-slate-800 text-[9px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
  }));
}
function NumericHeader(_ref31) {
  let {
    label,
    field,
    current,
    onSort,
    numFilters,
    setNumFilters,
    align = "left",
    widthClass
  } = _ref31;
  const isSorted = current.key === field;
  const filterMin = numFilters[field] ? numFilters[field].min : '';
  const filterMax = numFilters[field] ? numFilters[field].max : '';
  const handleMin = e => {
    const val = e.target.value;
    setNumFilters(p => {
      const n = {
        ...p
      };
      n[field] = {
        ...n[field],
        min: val
      };
      return n;
    });
  };
  const handleMax = e => {
    const val = e.target.value;
    setNumFilters(p => {
      const n = {
        ...p
      };
      n[field] = {
        ...n[field],
        max: val
      };
      return n;
    });
  };
  return /*#__PURE__*/React.createElement("th", {
    "data-metric": MetricColors.key(field),
    style: MetricColors.textStyle(field),
    className: `p-2 transition text-${align} bg-slate-50 relative group ${widthClass || 'w-auto'}`
  }, /*#__PURE__*/React.createElement("div", {
    onMouseDown: startResize,
    className: "absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize bg-transparent hover:bg-blue-400 z-20"
  }), /*#__PURE__*/React.createElement("div", {
    className: `flex items-center gap-1 cursor-pointer hover:text-blue-500 justify-${align === 'right' ? 'end' : align === 'center' ? 'center' : 'start'}`,
    onClick: () => onSort(field)
  }, label, " ", /*#__PURE__*/React.createElement("span", {
    className: "text-[8px] text-slate-400"
  }, isSorted ? current.direction === 'asc' ? '▲' : '▼' : '↕')), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1 mt-2",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    placeholder: "< Max",
    value: filterMax,
    onChange: handleMax,
    className: "w-full px-1 py-1 text-slate-800 text-[8px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    placeholder: "> Min",
    value: filterMin,
    onChange: handleMin,
    className: "w-full px-1 py-1 text-slate-800 text-[8px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
  })));
}
function DateFilterHeader(_ref32) {
  let {
    label,
    field,
    current,
    onSort,
    dateFilters,
    setDateFilters,
    align = "left",
    widthClass
  } = _ref32;
  const isSorted = current.key === field;
  const filterMin = dateFilters[field] ? dateFilters[field].min : '';
  const filterMax = dateFilters[field] ? dateFilters[field].max : '';
  const handleMin = e => {
    const val = e.target.value;
    setDateFilters(p => ({
      ...p,
      [field]: {
        ...p[field],
        min: val
      }
    }));
  };
  const handleMax = e => {
    const val = e.target.value;
    setDateFilters(p => ({
      ...p,
      [field]: {
        ...p[field],
        max: val
      }
    }));
  };
  return /*#__PURE__*/React.createElement("th", {
    className: `p-2 transition text-${align} bg-slate-50 relative group ${widthClass || 'w-auto'}`
  }, /*#__PURE__*/React.createElement("div", {
    onMouseDown: startResize,
    className: "absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize bg-transparent hover:bg-blue-400 z-20"
  }), /*#__PURE__*/React.createElement("div", {
    className: `flex items-center gap-1 cursor-pointer hover:text-blue-500 justify-${align === 'right' ? 'end' : align === 'center' ? 'center' : 'start'}`,
    onClick: () => onSort(field)
  }, label, " ", /*#__PURE__*/React.createElement("span", {
    className: "text-[8px] text-slate-400"
  }, isSorted ? current.direction === 'asc' ? '▲' : '▼' : '↕')), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-1 mt-2",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("input", {
    type: "date",
    title: "A partir de (M\xEDnimo)",
    value: filterMin,
    onChange: handleMin,
    className: "w-full px-1 py-1 text-slate-800 text-[8px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
  }), /*#__PURE__*/React.createElement("input", {
    type: "date",
    title: "At\xE9 (M\xE1ximo)",
    value: filterMax,
    onChange: handleMax,
    className: "w-full px-1 py-1 text-slate-800 text-[8px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
  })));
}
function MultiSelect(_ref33) {
  let {
    label,
    options,
    selected,
    onChange
  } = _ref33;
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef();
  useEffect(() => {
    const handleClickOutside = e => {
      if (ref.current && !ref.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  const toggleOption = opt => {
    if (selected.includes(opt)) onChange(selected.filter(item => item !== opt));else onChange([...selected, opt]);
  };
  const filteredOptions = options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  const markAllVisible = () => {
    onChange(Array.from(new Set([...selected, ...filteredOptions])));
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "relative",
    ref: ref
  }, /*#__PURE__*/React.createElement("label", {
    className: "text-[9px] font-black text-slate-400 block mb-1 uppercase tracking-widest"
  }, label), /*#__PURE__*/React.createElement("div", {
    className: "w-full bg-slate-50 border border-slate-200 p-2 rounded-lg text-xs font-bold text-slate-700 cursor-pointer flex justify-between items-center shadow-sm",
    onClick: () => setIsOpen(!isOpen),
    title: selected.length ? selected.join('\n') : 'TODOS OS REGISTROS'
  }, /*#__PURE__*/React.createElement("span", {
    className: "truncate"
  }, selected.length === 0 ? "TODOS OS REGISTROS" : `${selected.length} selecionado(s)`), /*#__PURE__*/React.createElement("span", {
    className: "text-[10px]"
  }, "\u25BC")), isOpen && /*#__PURE__*/React.createElement("div", {
    className: "absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-2xl max-h-72 flex flex-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "p-2 border-b bg-slate-50 flex flex-col gap-2"
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    placeholder: "Pesquisar...",
    value: search,
    onChange: e => setSearch(e.target.value),
    className: "w-full border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
  }), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: markAllVisible,
    className: "text-[9px] font-bold bg-slate-200 text-slate-800 px-2 py-1 rounded w-full hover:bg-slate-300"
  }, "Marcar Vis\xEDveis"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onChange([]),
    className: "text-[9px] font-bold bg-red-100 text-red-700 px-2 py-1 rounded w-full hover:bg-red-200"
  }, "Limpar"))), /*#__PURE__*/React.createElement("div", {
    className: "overflow-y-auto p-1"
  }, filteredOptions.length === 0 && /*#__PURE__*/React.createElement("p", {
    className: "text-[10px] text-center text-slate-400 p-2"
  }, "Sem resultados."), filteredOptions.map((o, i) => /*#__PURE__*/React.createElement("label", {
    key: i,
    className: "flex items-center px-2 py-2 hover:bg-blue-50 cursor-pointer text-[10px] font-bold text-slate-700 border-b border-slate-100 last:border-0"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: selected.includes(o),
    onChange: () => toggleOption(o),
    className: "mr-2 cursor-pointer"
  }), /*#__PURE__*/React.createElement("span", {
    className: "truncate leading-tight",
    title: o
  }, o))))));
}
function DateInput(_ref34) {
  let {
    label,
    value,
    onChange
  } = _ref34;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "text-[9px] font-black text-slate-400 block mb-1 uppercase tracking-widest"
  }, label), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: value,
    onChange: e => onChange(e.target.value),
    className: "w-full bg-slate-50 border border-slate-200 p-2 rounded-lg text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-500 transition shadow-sm cursor-pointer"
  }));
}
function AccessMetadata() {
  const [currentDateTime, setCurrentDateTime] = useState(() => new Date());
  const [accessLocation, setAccessLocation] = useState('LOCALIZAÇÃO EM CONSULTA');
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentDateTime(new Date()), 1000);
    let cancelled = false;
    const fetchLocation = async () => {
      const providers = [async () => {
        const response = await fetch('https://ipapi.co/json/');
        if (!response.ok) throw new Error('ipapi indisponível');
        const location = await response.json();
        return [location.city, location.country_name].filter(Boolean).join(', ');
      }, async () => {
        const response = await fetch('https://ipwho.is/');
        if (!response.ok) throw new Error('ipwho indisponível');
        const location = await response.json();
        return [location.city, location.country].filter(Boolean).join(', ');
      }];
      for (const provider of providers) {
        try {
          const location = await provider();
          if (location) {
            if (!cancelled) setAccessLocation(location);
            return;
          }
        } catch (error) {}
      }
      if (!cancelled) setAccessLocation('LOCALIZAÇÃO INDISPONÍVEL');
    };
    fetchLocation();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const datePart = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).format(currentDateTime);
  const timePart = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(currentDateTime);
  return /*#__PURE__*/React.createElement("div", {
    "data-access-metadata": true,
    "data-access-location": accessLocation,
    className: "min-w-[245px] text-[11px] font-bold leading-5 text-slate-600 whitespace-nowrap"
  }, /*#__PURE__*/React.createElement("p", {
    title: "Localiza\xE7\xE3o aproximada obtida pelo IP de acesso"
  }, accessLocation, " \u2013 ", datePart, "; ", timePart), /*#__PURE__*/React.createElement("p", null, "Vers\xE3o ", DASH_VERSION), /*#__PURE__*/React.createElement("p", {
    className: "italic"
  }, "Produzido por Cel Brito"));
}
function CollapsibleSection(_ref35) {
  let {
    title,
    children,
    defaultOpen = false,
    globalTrigger,
    globalState
  } = _ref35;
  const [isOpen, setIsOpen] = useState(defaultOpen);
  useEffect(() => {
    if (globalTrigger > 0) setIsOpen(globalState);
  }, [globalTrigger, globalState]);
  return /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto mb-8"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 text-white px-6 py-4 rounded-xl cursor-pointer flex justify-between items-center shadow-lg hover:bg-slate-700 transition border border-slate-700",
    onClick: () => setIsOpen(!isOpen)
  }, /*#__PURE__*/React.createElement("h2", {
    className: "text-sm font-black tracking-widest uppercase flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "w-2 h-2 bg-blue-500 rounded-full"
  }), title), /*#__PURE__*/React.createElement("span", {
    className: "font-bold text-lg text-slate-300"
  }, isOpen ? '▼' : '►')), isOpen && /*#__PURE__*/React.createElement("div", {
    className: "mt-6"
  }, children));
}

// 5. DOCUMENTOS — carga, relacionamento contábil e filtros locais compartilhados com o painel.
const DocumentModule = ((sharedExports, sharedChart) => {
  const tagColorsMap = {
    'VIG SEM EXEC': {
      css: 'bg-purple-700 text-white',
      hex: '#7e22ce'
    },
    'VIG EM EXEC': {
      css: 'bg-cyan-500 text-slate-900',
      hex: '#06b6d4'
    },
    'VIG EXEC TOTAL': {
      css: 'bg-blue-800 text-white',
      hex: '#1e40af'
    },
    'VIG EXEC PARCIAL': {
      css: 'bg-sky-400 text-slate-900',
      hex: '#38bdf8'
    },
    'VENC INEXEC TOTAL': {
      css: 'bg-rose-900 text-white',
      hex: '#881337'
    },
    'VENC EXEC TOTAL': {
      css: 'bg-green-600 text-white',
      hex: '#16a34a'
    },
    'VENC EXEC PARCIAL': {
      css: 'bg-yellow-500 text-slate-900',
      hex: '#eab308'
    },
    'CAN': {
      css: 'bg-red-600 text-white',
      hex: '#dc2626'
    },
    'BLOQ': {
      css: 'bg-orange-500 text-white',
      hex: '#f97316'
    },
    'SÓ EM GERAL': {
      css: 'bg-amber-900 text-white',
      hex: '#78350f'
    },
    'SÓ EM CONTÁBIL': {
      css: 'bg-orange-900 text-white',
      hex: '#7c2d12'
    }
  };
  const _decode = str => {
    if (!str) return "";
    if (/^[01\s]+$/.test(str.trim())) {
      try {
        return str.trim().split(' ').map(b => String.fromCharCode(parseInt(b, 2))).join('');
      } catch (e) {
        return str;
      }
    }
    return str;
  };
  const cSupItemsList = ["SGLS-CLASSE I", "SGLFE-CLASSE II", "SGLC-CLASSE III", "SGLME-CLASSE V (MUN)"];
  const getTodayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const normalizeStr = str => str ? str.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : "";
  const parseValue = UnifiedData.number;
  const formatBRL = UnifiedData.brl;
  const formatPercentBR = UnifiedData.percent;
  const shortenNumber = num => {
    if (!num) return "0";
    if (num >= 1e9) return (num / 1e9).toFixed(1).replace('.', ',') + ' Bi';
    if (num >= 1e6) return (num / 1e6).toFixed(1).replace('.', ',') + ' Mi';
    if (num >= 1e3) return (num / 1e3).toFixed(1).replace('.', ',') + ' Mil';
    return num.toString();
  };
  const parseDateBR = UnifiedData.date;
  const formatLabelMultiLine = function (text) {
    let maxLength = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 18;
    if (!text) return [""];
    let cleanText = text.replace(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\s*-\s*/, '');
    if (cleanText.length <= maxLength) return [cleanText];
    const words = cleanText.split(' ');
    let lines = [];
    let currentLine = '';
    words.forEach(word => {
      if ((currentLine + word).length > maxLength) {
        if (currentLine) lines.push(currentLine.trim());
        currentLine = word + ' ';
      } else {
        currentLine += word + ' ';
      }
    });
    if (currentLine) lines.push(currentLine.trim());
    if (lines.length > 2) return [lines[0], lines[1].substring(0, maxLength - 3) + '...'];
    return lines;
  };
  const startResize = e => {
    const th = e.target.closest('th');
    if (!th) return;
    const startX = e.pageX;
    const startWidth = th.getBoundingClientRect().width;
    const onMouseMove = moveEvent => {
      th.style.width = `${Math.max(40, startWidth + moveEvent.pageX - startX)}px`;
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };
  const exportTable = sharedExports;
  const FormatNegativeValue = _ref36 => {
    let {
      val
    } = _ref36;
    if (val === null || val === undefined) return /*#__PURE__*/React.createElement("span", null, "-");
    const isNegative = val < -0.001;
    return /*#__PURE__*/React.createElement("span", {
      className: isNegative ? "underline decoration-red-500 decoration-[2px] underline-offset-2" : ""
    }, formatBRL(val));
  };
  const ContratoCell = _ref37 => {
    let {
      row
    } = _ref37;
    return /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col"
    }, /*#__PURE__*/React.createElement("span", {
      className: "font-black text-slate-800 text-[10px] whitespace-normal break-words"
    }, row.contrato), /*#__PURE__*/React.createElement("span", {
      className: "text-[8px] text-slate-500 mt-1 whitespace-normal break-words"
    }, "Compra: ", row.compra), /*#__PURE__*/React.createElement("span", {
      className: "text-[8px] text-slate-500 leading-tight whitespace-normal break-words"
    }, "Mod: ", row.modalidade));
  };
  function CollapsibleSection(_ref38) {
    let {
      title,
      children,
      defaultOpen = false,
      globalTrigger,
      globalState
    } = _ref38;
    const [isOpen, setIsOpen] = useState(defaultOpen);
    useEffect(() => {
      if (globalTrigger > 0) setIsOpen(globalState);
    }, [globalTrigger, globalState]);
    return /*#__PURE__*/React.createElement("div", {
      className: "max-w-[1600px] mx-auto mb-8"
    }, /*#__PURE__*/React.createElement("div", {
      className: "bg-slate-800 text-white px-6 py-4 rounded-xl cursor-pointer flex justify-between items-center shadow-lg hover:bg-slate-700 transition border border-slate-700",
      onClick: () => setIsOpen(!isOpen)
    }, /*#__PURE__*/React.createElement("h2", {
      className: "text-sm font-black tracking-widest uppercase flex items-center gap-2"
    }, /*#__PURE__*/React.createElement("span", {
      className: "w-2 h-2 bg-blue-500 rounded-full"
    }), title), /*#__PURE__*/React.createElement("span", {
      className: "font-bold text-lg text-slate-300"
    }, isOpen ? '▼' : '►')), isOpen && /*#__PURE__*/React.createElement("div", {
      className: "mt-6"
    }, children));
  }
  function AutoFitText(_ref39) {
    let {
      text,
      className
    } = _ref39;
    const containerRef = useRef(null);
    const textRef = useRef(null);
    useEffect(() => {
      const resize = () => {
        if (containerRef.current && textRef.current) {
          textRef.current.style.transform = 'none';
          const cw = containerRef.current.clientWidth;
          const tw = textRef.current.scrollWidth;
          if (tw > cw && cw > 0) {
            textRef.current.style.transform = `scale(${cw / tw})`;
          }
        }
      };
      resize();
      setTimeout(resize, 50);
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, [text]);
    return /*#__PURE__*/React.createElement("div", {
      ref: containerRef,
      className: "w-full overflow-hidden flex items-center"
    }, /*#__PURE__*/React.createElement("div", {
      ref: textRef,
      className: `${className} origin-left whitespace-nowrap inline-block`
    }, text));
  }
  const ChartComponent = sharedChart;
  function DocumentComposition(_ref40) {
    let {
      counts,
      amounts,
      uniqueDocs
    } = _ref40;
    const canvasRef = useRef(null);
    const rows = useMemo(() => {
      const stages = [{
        stage: 'EMPENHADO',
        key: 'empenhado',
        amount: 'emp',
        color: '#3b82f6'
      }, {
        stage: 'RECEBIDO',
        key: 'recebido',
        amount: 'rec',
        color: '#8b5cf6'
      }, {
        stage: 'LIQUIDADO',
        key: 'liquidado',
        amount: 'liq',
        color: '#f59e0b'
      }, {
        stage: 'PAGO',
        key: 'pago',
        amount: 'pag',
        color: '#10b981'
      }];
      const totalCounts = stages.reduce((sum, stage) => sum + (counts[stage.key] || 0), 0);
      return stages.map(stage => {
        var _MetricColors$get;
        return {
          stage: stage.stage,
          color: ((_MetricColors$get = MetricColors.get(stage.key)) === null || _MetricColors$get === void 0 ? void 0 : _MetricColors$get.color) || stage.color,
          count: counts[stage.key] || 0,
          countShare: totalCounts ? (counts[stage.key] || 0) / totalCounts : 0,
          value: amounts[stage.amount] || 0,
          valueShare: amounts.emp ? (amounts[stage.amount] || 0) / amounts.emp : 0
        };
      });
    }, [counts, amounts]);
    const columns = [{
      header: 'ESTÁGIO',
      key: 'stage'
    }, {
      header: 'QTD DE DOCUMENTOS',
      key: 'count'
    }, {
      header: '% DAS PARTICIPAÇÕES POR ESTÁGIO',
      key: 'countShare',
      isPercent: true
    }, {
      header: 'VOLUME FINANCEIRO',
      key: 'value',
      isCurrency: true
    }, {
      header: '% DO EMPENHADO',
      key: 'valueShare',
      isPercent: true
    }, {
      header: 'TOTAL DE DOCUMENTOS ÚNICOS NO RECORTE',
      key: 'uniqueDocs'
    }];
    const exportRows = rows.map(row => ({
      ...row,
      uniqueDocs
    }));
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      canvas.width = 1100;
      canvas.height = 1120;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#334155';
      ctx.font = '800 28px Outfit, Arial, sans-serif';
      ctx.fillText('QTD DE DOCUMENTOS ÚNICOS', 550, 36);
      const totalCount = rows.reduce((sum, row) => sum + row.count, 0),
        cx = 550,
        cy = 235,
        radius = 155,
        inner = 92;
      let angle = -Math.PI / 2;
      if (!totalCount) {
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = radius - inner;
        ctx.beginPath();
        ctx.arc(cx, cy, (radius + inner) / 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      rows.forEach((row, index) => {
        if (row.count <= 0 || totalCount <= 0) return;
        const end = angle + row.countShare * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, angle, end);
        ctx.arc(cx, cy, inner, end, angle, true);
        ctx.closePath();
        ctx.fillStyle = row.color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();
        angle = end;
      });
      ctx.fillStyle = '#1e293b';
      ctx.font = '900 52px Outfit, Arial, sans-serif';
      ctx.fillText(Number(uniqueDocs || 0).toLocaleString('pt-BR'), cx, cy - 8);
      ctx.font = '700 19px Outfit, Arial, sans-serif';
      ctx.fillText('TOTAL DOCS', cx, cy + 36);
      rows.forEach((row, index) => {
        const x = index % 2 === 0 ? 35 : 660,
          y = 420 + Math.floor(index / 2) * 54;
        ctx.fillStyle = row.color;
        ctx.fillRect(x, y - 10, 20, 20);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#334155';
        ctx.font = '800 20px Outfit, Arial, sans-serif';
        ctx.fillText(`${row.stage}: ${row.count.toLocaleString('pt-BR')} (${formatPercentBR(row.countShare)})`, x + 30, y, 405);
      });
      ctx.textAlign = 'center';
      ctx.fillStyle = '#334155';
      ctx.font = '800 28px Outfit, Arial, sans-serif';
      ctx.fillText('VOLUME FINANCEIRO TOTAL (R$)', 550, 555);
      const maxValue = Math.max(1, ...rows.map(row => Math.max(0, row.value))),
        widthAt = value => Math.max(0, value) / maxValue * 670;
      rows.forEach((row, index) => {
        const y = 610 + index * 112,
          topWidth = widthAt(row.value);
        const nextWidth = index < rows.length - 1 ? widthAt(rows[index + 1].value) : Math.max(topWidth * 0.65, 0);
        const center = 590,
          bottomY = y + 96,
          left = center - topWidth / 2,
          right = center + topWidth / 2;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.lineTo(center + nextWidth / 2, bottomY);
        ctx.lineTo(center - nextWidth / 2, bottomY);
        ctx.closePath();
        ctx.fillStyle = row.color;
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.fillStyle = '#334155';
        ctx.font = '800 20px Outfit, Arial, sans-serif';
        ctx.fillText(row.stage, 25, y + 48);
        ctx.strokeStyle = row.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(180, y + 48);
        ctx.lineTo(Math.max(190, center - (topWidth + nextWidth) / 4), y + 48);
        ctx.stroke();
        const financialText = formatBRL(row.value),
          percentageText = `${formatPercentBR(row.valueShare)} do empenhado`;
        ctx.font = '900 25px Outfit, Arial, sans-serif';
        const fitsInside = Math.min(topWidth, nextWidth) >= Math.max(ctx.measureText(financialText).width + 24, 260);
        ctx.textAlign = fitsInside ? 'center' : 'right';
        ctx.fillStyle = fitsInside ? '#000' : '#334155';
        const valueX = fitsInside ? center : 1075;
        ctx.fillText(financialText, valueX, y + 36);
        ctx.font = '700 19px Outfit, Arial, sans-serif';
        ctx.fillText(percentageText, valueX, y + 66);
      });
      ctx.textAlign = 'center';
      ctx.fillStyle = '#64748b';
      ctx.font = '600 18px Outfit, Arial, sans-serif';
      ctx.fillText('Um documento pode participar de mais de um estágio.', 550, 1090);
    }, [rows, uniqueDocs]);
    const name = 'Composicao_de_Documentos';
    return /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col gap-3"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap justify-end gap-1",
      "aria-label": "Exportar composi\xE7\xE3o completa dos documentos"
    }, /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => exportTable.toPNG(canvasRef.current, name, 'COMPOSIÇÃO DE DOCUMENTOS — QUANTIDADES E VALORES'),
      className: "rounded bg-slate-700 px-2 py-1 text-[9px] font-black text-white"
    }, "PNG"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => exportTable.toExcel(exportRows, name, columns),
      className: "rounded bg-green-600 px-2 py-1 text-[9px] font-black text-white"
    }, "EXCEL"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => exportTable.toCSV(exportRows, name, columns),
      className: "rounded bg-blue-600 px-2 py-1 text-[9px] font-black text-white"
    }, "CSV"), /*#__PURE__*/React.createElement("button", {
      type: "button",
      onClick: () => exportTable.toPDF(exportRows, name, columns, 'COMPOSIÇÃO DE DOCUMENTOS — QUANTIDADES E VALORES'),
      className: "rounded bg-red-600 px-2 py-1 text-[9px] font-black text-white"
    }, "PDF")), /*#__PURE__*/React.createElement("div", {
      className: "overflow-x-auto"
    }, /*#__PURE__*/React.createElement("canvas", {
      ref: canvasRef,
      className: "mx-auto block h-auto w-full min-w-[660px] max-w-[900px]",
      "aria-label": rows.map(row => `${row.stage}: ${row.count} documentos, ${formatPercentBR(row.countShare)} das participações; ${formatBRL(row.value)}, ${formatPercentBR(row.valueShare)} do empenhado`).join('; '),
      role: "img"
    })));
  }
  function LatestDocCard(_ref41) {
    var _MetricColors$get2;
    let {
      title,
      docs,
      metricField,
      colorClass,
      showEmitente
    } = _ref41;
    const first = docs === null || docs === void 0 ? void 0 : docs[0];
    const totalValue = useMemo(() => (docs || []).reduce((sum, doc) => sum + (doc[metricField] || 0), 0), [docs, metricField]);
    const daysText = useMemo(() => {
      if (!(first !== null && first !== void 0 && first.diaVal)) return '';
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const days = Math.floor((today.getTime() - first.diaVal) / 86400000);
      return `${days} dia${days === 1 ? '' : 's'}`;
    }, [first === null || first === void 0 ? void 0 : first.diaVal]);
    return /*#__PURE__*/React.createElement("div", {
      className: `p-4 rounded-2xl shadow-sm border border-t-4 bg-white flex flex-col h-full max-h-[320px] min-w-0 ${colorClass.split(' ')[0]}`,
      "data-metric": MetricColors.key(metricField),
      style: {
        borderTopColor: (_MetricColors$get2 = MetricColors.get(metricField)) === null || _MetricColors$get2 === void 0 ? void 0 : _MetricColors$get2.color
      }
    }, /*#__PURE__*/React.createElement("h4", {
      className: `mb-3 text-[10px] font-black uppercase tracking-widest ${colorClass.split(' ')[1]}`,
      style: MetricColors.textStyle(metricField)
    }, title, " (", (docs === null || docs === void 0 ? void 0 : docs.length) || 0, ")"), !first ? /*#__PURE__*/React.createElement("p", {
      className: "text-xs font-bold text-slate-400"
    }, "Nenhum documento encontrado.") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "mb-3 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 border-b border-slate-100 pb-2 text-[9px] font-bold"
    }, /*#__PURE__*/React.createElement("span", {
      className: "whitespace-nowrap text-slate-500"
    }, first.dia, " ", daysText && `(${daysText})`), /*#__PURE__*/React.createElement("span", {
      className: `min-w-0 text-right ${colorClass.split(' ')[1]}`,
      style: MetricColors.textStyle(metricField)
    }, /*#__PURE__*/React.createElement(AutoFitText, {
      text: formatBRL(totalValue),
      className: "font-black text-[10px]"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1 custom-scrollbar"
    }, docs.map((doc, index) => /*#__PURE__*/React.createElement("div", {
      key: index,
      className: "border-b border-slate-100 py-1.5 last:border-0"
    }, /*#__PURE__*/React.createElement("div", {
      className: "mb-1 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 text-[10px]"
    }, /*#__PURE__*/React.createElement("time", {
      className: "whitespace-nowrap font-bold text-slate-500"
    }, doc.dia), /*#__PURE__*/React.createElement("span", {
      className: `min-w-0 text-right ${colorClass.split(' ')[1]}`,
      style: MetricColors.textStyle(metricField)
    }, /*#__PURE__*/React.createElement(AutoFitText, {
      text: formatBRL(doc[metricField]),
      className: `font-black text-[10px] ${doc[metricField] < -0.001 ? 'underline decoration-red-500 decoration-[2px] underline-offset-2' : ''}`
    }))), /*#__PURE__*/React.createElement("div", {
      className: "break-words text-[10px] font-bold text-slate-700",
      title: `Favorecido: ${doc.favorecido || 'N/I'} | Objeto: ${doc.objeto || '-'}`
    }, /*#__PURE__*/React.createElement(PortalDocumentLink, {
      value: doc.documento,
      context: doc
    }), " ", /*#__PURE__*/React.createElement("span", {
      className: "text-[9px] text-slate-400"
    }, "(", doc.contrato, ")")), showEmitente && /*#__PURE__*/React.createElement("div", {
      className: "break-words text-[9px] font-bold text-slate-500"
    }, doc.ug))))));
  }
  function TextHeader(_ref42) {
    let {
      label,
      field,
      current,
      onSort,
      align = "left",
      searchVal,
      onSearchChange,
      widthClass
    } = _ref42;
    const isSorted = current.key === field;
    return /*#__PURE__*/React.createElement("th", {
      className: `p-2 transition text-${align} bg-slate-50 relative group ${widthClass || 'w-auto'}`
    }, /*#__PURE__*/React.createElement("div", {
      onMouseDown: startResize,
      className: "absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize bg-transparent hover:bg-blue-400 z-20"
    }), /*#__PURE__*/React.createElement("div", {
      className: `flex items-center gap-1 cursor-pointer hover:text-blue-500 justify-${align === 'right' ? 'end' : align === 'center' ? 'center' : 'start'}`,
      onClick: () => onSort(field)
    }, label, " ", /*#__PURE__*/React.createElement("span", {
      className: "text-[8px] text-slate-400"
    }, isSorted ? current.direction === 'asc' ? '▲' : '▼' : '↕')), onSearchChange !== undefined && /*#__PURE__*/React.createElement("input", {
      type: "text",
      placeholder: "Buscar...",
      value: searchVal,
      onChange: e => onSearchChange(e.target.value),
      onClick: e => e.stopPropagation(),
      className: "mt-2 w-full px-1 py-1 text-slate-800 text-[9px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
    }));
  }
  function NumericHeader(_ref43) {
    let {
      label,
      field,
      current,
      onSort,
      numFilters,
      setNumFilters,
      align = "left",
      widthClass
    } = _ref43;
    const isSorted = current.key === field;
    const handleMin = e => setNumFilters(p => ({
      ...p,
      [field]: {
        ...p[field],
        min: e.target.value
      }
    }));
    const handleMax = e => setNumFilters(p => ({
      ...p,
      [field]: {
        ...p[field],
        max: e.target.value
      }
    }));
    return /*#__PURE__*/React.createElement("th", {
      "data-metric": MetricColors.key(field),
      style: MetricColors.textStyle(field),
      className: `p-2 transition text-${align} bg-slate-50 relative group ${widthClass || 'w-auto'}`
    }, /*#__PURE__*/React.createElement("div", {
      onMouseDown: startResize,
      className: "absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize bg-transparent hover:bg-blue-400 z-20"
    }), /*#__PURE__*/React.createElement("div", {
      className: `flex items-center gap-1 cursor-pointer hover:text-blue-500 justify-${align === 'right' ? 'end' : align === 'center' ? 'center' : 'start'}`,
      onClick: () => onSort(field)
    }, label, " ", /*#__PURE__*/React.createElement("span", {
      className: "text-[8px] text-slate-400"
    }, isSorted ? current.direction === 'asc' ? '▲' : '▼' : '↕')), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col gap-1 mt-2",
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("input", {
      type: "number",
      placeholder: "< Max",
      value: numFilters[field] ? numFilters[field].max : '',
      onChange: handleMax,
      className: "w-full px-1 py-1 text-slate-800 text-[8px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      placeholder: "> Min",
      value: numFilters[field] ? numFilters[field].min : '',
      onChange: handleMin,
      className: "w-full px-1 py-1 text-slate-800 text-[8px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
    })));
  }
  function DateFilterHeader(_ref44) {
    let {
      label,
      field,
      current,
      onSort,
      dateFilters,
      setDateFilters,
      align = "left",
      widthClass
    } = _ref44;
    const isSorted = current.key === field;
    const handleMin = e => setDateFilters(p => ({
      ...p,
      [field]: {
        ...p[field],
        min: e.target.value
      }
    }));
    const handleMax = e => setDateFilters(p => ({
      ...p,
      [field]: {
        ...p[field],
        max: e.target.value
      }
    }));
    return /*#__PURE__*/React.createElement("th", {
      className: `p-2 transition text-${align} bg-slate-50 relative group ${widthClass || 'w-auto'}`
    }, /*#__PURE__*/React.createElement("div", {
      onMouseDown: startResize,
      className: "absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize bg-transparent hover:bg-blue-400 z-20"
    }), /*#__PURE__*/React.createElement("div", {
      className: `flex items-center gap-1 cursor-pointer hover:text-blue-500 justify-${align === 'right' ? 'end' : align === 'center' ? 'center' : 'start'}`,
      onClick: () => onSort(field)
    }, label, " ", /*#__PURE__*/React.createElement("span", {
      className: "text-[8px] text-slate-400"
    }, isSorted ? current.direction === 'asc' ? '▲' : '▼' : '↕')), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col gap-1 mt-2",
      onClick: e => e.stopPropagation()
    }, /*#__PURE__*/React.createElement("input", {
      type: "date",
      title: "A partir de (M\xEDnimo)",
      value: dateFilters[field] ? dateFilters[field].min : '',
      onChange: handleMin,
      className: "w-full px-1 py-1 text-slate-800 text-[8px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
    }), /*#__PURE__*/React.createElement("input", {
      type: "date",
      title: "At\xE9 (M\xE1ximo)",
      value: dateFilters[field] ? dateFilters[field].max : '',
      onChange: handleMax,
      className: "w-full px-1 py-1 text-slate-800 text-[8px] font-normal rounded border border-slate-300 outline-none focus:border-blue-500 shadow-inner"
    })));
  }
  function MultiSelect(_ref45) {
    let {
      label,
      options,
      selected,
      onChange
    } = _ref45;
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const ref = useRef();
    useEffect(() => {
      const handleClickOutside = e => {
        if (ref.current && !ref.current.contains(e.target)) setIsOpen(false);
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);
    const toggleOption = opt => {
      if (selected.includes(opt)) onChange(selected.filter(item => item !== opt));else onChange([...selected, opt]);
    };
    const filteredOptions = options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
    const markAllVisible = () => {
      onChange(Array.from(new Set([...selected, ...filteredOptions])));
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "relative",
      ref: ref
    }, /*#__PURE__*/React.createElement("label", {
      className: "text-[9px] font-black text-slate-400 block mb-1 uppercase tracking-widest"
    }, label), /*#__PURE__*/React.createElement("div", {
      className: "w-full bg-slate-50 border border-slate-200 p-2 rounded-lg text-xs font-bold text-slate-700 cursor-pointer flex justify-between items-center shadow-sm",
      onClick: () => setIsOpen(!isOpen)
    }, /*#__PURE__*/React.createElement("span", {
      className: "truncate"
    }, selected.length === 0 ? "TODOS OS REGISTROS" : `${selected.length} selecionado(s)`), /*#__PURE__*/React.createElement("span", {
      className: "text-[10px]"
    }, "\u25BC")), isOpen && /*#__PURE__*/React.createElement("div", {
      className: "absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-2xl max-h-72 flex flex-col"
    }, /*#__PURE__*/React.createElement("div", {
      className: "p-2 border-b bg-slate-50 flex flex-col gap-2"
    }, /*#__PURE__*/React.createElement("input", {
      type: "text",
      placeholder: "Pesquisar...",
      value: search,
      onChange: e => setSearch(e.target.value),
      className: "w-full border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
    }), /*#__PURE__*/React.createElement("div", {
      className: "flex gap-2"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: markAllVisible,
      className: "text-[9px] font-bold bg-slate-200 text-slate-800 px-2 py-1 rounded w-full hover:bg-slate-300"
    }, "Marcar Vis\xEDveis"), /*#__PURE__*/React.createElement("button", {
      onClick: () => onChange([]),
      className: "text-[9px] font-bold bg-red-100 text-red-700 px-2 py-1 rounded w-full hover:bg-red-200"
    }, "Limpar"))), /*#__PURE__*/React.createElement("div", {
      className: "overflow-y-auto p-1"
    }, filteredOptions.length === 0 && /*#__PURE__*/React.createElement("p", {
      className: "text-[10px] text-center text-slate-400 p-2"
    }, "Sem resultados."), filteredOptions.map((o, i) => /*#__PURE__*/React.createElement("label", {
      key: i,
      className: "flex items-center px-2 py-2 hover:bg-blue-50 cursor-pointer text-[10px] font-bold text-slate-700 border-b border-slate-100 last:border-0"
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: selected.includes(o),
      onChange: () => toggleOption(o),
      className: "mr-2 cursor-pointer"
    }), /*#__PURE__*/React.createElement("span", {
      className: "truncate leading-tight"
    }, o))))));
  }
  function DateInput(_ref46) {
    let {
      label,
      value,
      onChange
    } = _ref46;
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "text-[9px] font-black text-slate-400 block mb-1 uppercase tracking-widest"
    }, label), /*#__PURE__*/React.createElement("input", {
      type: "date",
      value: value,
      onChange: e => onChange(e.target.value),
      className: "w-full bg-slate-50 border border-slate-200 p-2 rounded-lg text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-500 transition shadow-sm cursor-pointer"
    }));
  }
  function KPICard(_ref47) {
    let {
      title,
      value,
      subValue,
      diffText,
      percSuffix,
      color,
      isCurrency,
      extraText
    } = _ref47;
    const colors = {
      slate: "border-slate-800 text-slate-800",
      blue: "border-blue-500 text-blue-700",
      violet: "border-violet-500 text-violet-700",
      amber: "border-amber-500 text-amber-600",
      emerald: "border-emerald-500 text-emerald-600",
      red: "border-red-500 text-red-600",
      orange: "border-orange-500 text-orange-600"
    };
    const mainText = isCurrency ? formatBRL(value) : value.toLocaleString('pt-BR');
    const subText = subValue !== undefined ? `${formatPercentBR(subValue)}${percSuffix || ''}` : '';
    return /*#__PURE__*/React.createElement("div", {
      className: `bg-white p-3 sm:p-5 rounded-2xl border-t-8 shadow-md flex flex-col justify-start overflow-hidden min-w-0 ${colors[color]}`,
      "data-metric": isCurrency ? MetricColors.key(title) : undefined,
      style: isCurrency ? MetricColors.cardStyle(title) : undefined
    }, /*#__PURE__*/React.createElement("h3", {
      className: "text-[10px] font-black uppercase tracking-widest opacity-50 mb-1 truncate",
      title: title
    }, title), /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col w-full min-w-0"
    }, /*#__PURE__*/React.createElement(AutoFitText, {
      text: mainText,
      className: "font-black text-2xl tracking-tight"
    }), diffText && /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] font-bold text-slate-500 mt-1 truncate"
    }, diffText), subValue !== undefined && /*#__PURE__*/React.createElement("div", {
      className: "text-[10px] font-bold opacity-70 mt-1 truncate"
    }, subText), extraText && /*#__PURE__*/React.createElement("div", {
      className: "text-[9.5px] font-bold text-slate-500 mt-2 leading-[1.1] border-t border-slate-100 pt-1"
    }, extraText.split('\n').map((line, idx) => /*#__PURE__*/React.createElement("div", {
      key: idx
    }, line)))));
  }
  function DocStatCard(_ref48) {
    let {
      title,
      count,
      date,
      timestamp
    } = _ref48;
    const daysText = useMemo(() => {
      if (!timestamp) return '';
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const docDate = new Date(timestamp);
      docDate.setHours(0, 0, 0, 0);
      const diffDays = Math.floor((today - docDate) / 86400000);
      return ` (${diffDays} dia${diffDays === 1 ? '' : 's'} até hoje)`;
    }, [timestamp]);
    return /*#__PURE__*/React.createElement("div", {
      className: "bg-white p-3 sm:p-4 rounded-2xl border-t-4 border-slate-400 shadow-md flex flex-col justify-start overflow-hidden min-w-0"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "text-[9px] font-black uppercase tracking-widest opacity-60 mb-1 truncate",
      title: title
    }, title), /*#__PURE__*/React.createElement("div", {
      className: "font-black text-xl sm:text-2xl tracking-tight text-slate-800"
    }, count.toLocaleString('pt-BR')), /*#__PURE__*/React.createElement("div", {
      className: "text-[9px] font-bold text-slate-500 mt-1 uppercase"
    }, "\xDAltimo: ", date || '-', daysText));
  }

  // =========================================================
  // COMPONENTE: SUBTABELA DETALHADA
  // =========================================================
  function SubTable(_ref49) {
    let {
      title,
      data,
      metricField,
      metricLabel,
      headerColor,
      rowBgColor,
      textColor,
      showDiasAss = false
    } = _ref49;
    const [limit, setLimit] = useState(100);
    const [sortConfig, setSortConfig] = useState({
      key: 'diaVal',
      direction: 'desc'
    });

    // Controle Dinâmico de Colunas para a SubTabela
    const [showColsMenu, setShowColsMenu] = useState(false);
    const [visibleCols, setVisibleCols] = useState({
      dia: true,
      contrato: true,
      arquivos: true,
      sec_log: true,
      existencia: true,
      situacao: true,
      movimento: true,
      diasAss: showDiasAss,
      vigencia: true,
      perc_tempo: true,
      emitente: true,
      favorecido: true,
      objeto: true,
      gestor: true,
      empenho: true,
      documento: true,
      obs: true,
      metricas: true
    });
    const [searchContrato, setSearchContrato] = useState("");
    const [searchSituacao, setSearchSituacao] = useState("");
    const [searchExistencia, setSearchExistencia] = useState("");
    const [searchMovimento, setSearchMovimento] = useState("");
    const [searchUgNome, setSearchUgNome] = useState("");
    const [searchEmpenho, setSearchEmpenho] = useState("");
    const [searchDocumento, setSearchDocumento] = useState("");
    const [searchObs, setSearchObs] = useState("");
    const [searchEmitente, setSearchEmitente] = useState("");
    const [searchSecLog, setSearchSecLog] = useState("");
    const [searchGestor, setSearchGestor] = useState("");
    const [numFilters, setNumFilters] = useState({
      [metricField]: {
        min: '',
        max: ''
      },
      perc_tempo: {
        min: '',
        max: ''
      },
      diasAss: {
        min: '',
        max: ''
      }
    });
    const [dateFilters, setDateFilters] = useState({
      dia: {
        min: '',
        max: ''
      },
      data_inic: {
        min: '',
        max: ''
      },
      data_fim: {
        min: '',
        max: ''
      }
    });
    const handleSort = key => setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
    const tableData = useMemo(() => {
      const hasField = metricField.replace('v_', 'has_');
      let filtered = data.filter(row => row[hasField]);
      filtered = filtered.filter(item => {
        const matchContrato = !searchContrato || item.contrato.includes(searchContrato.toUpperCase()) || item.compra.includes(searchContrato.toUpperCase()) || item.modalidade.includes(searchContrato.toUpperCase());
        const matchSit = !searchSituacao || item.situacao.includes(searchSituacao.toUpperCase());
        const matchExistencia = !searchExistencia || item.existencia.includes(searchExistencia.toUpperCase());
        const matchMovimento = !searchMovimento || item.movimentoStr.includes(searchMovimento.toUpperCase());
        const matchEmitente = !searchEmitente || item.ug.includes(searchEmitente.toUpperCase());
        const matchUgNome = !searchUgNome || item.favorecido.includes(searchUgNome.toUpperCase());
        const matchEmpenho = !searchEmpenho || item.empenho.includes(searchEmpenho.toUpperCase());
        const matchDocumento = !searchDocumento || item.documento.includes(searchDocumento.toUpperCase());
        const matchObs = !searchObs || item.obs.includes(searchObs.toUpperCase());
        const matchSecLog = !searchSecLog || item.sec_log.includes(searchSecLog.toUpperCase());
        const matchGestor = !searchGestor || item.gestor.includes(searchGestor.toUpperCase()) || item.fiscal.includes(searchGestor.toUpperCase());
        let matchNum = true;
        for (const key in numFilters) {
          if (numFilters[key] && (numFilters[key].min !== '' || numFilters[key].max !== '')) {
            let val = item[key];
            if (val === null || val === undefined) {
              matchNum = false;
              break;
            }
            if (key.startsWith('p_')) val = val * 100;
            if (numFilters[key].min !== '' && val < parseFloat(numFilters[key].min)) {
              matchNum = false;
              break;
            }
            if (numFilters[key].max !== '' && val > parseFloat(numFilters[key].max)) {
              matchNum = false;
              break;
            }
          }
        }
        let matchDateCol = true;
        if (dateFilters.dia) {
          if (dateFilters.dia.min && item.diaVal !== 0 && item.diaVal < new Date(dateFilters.dia.min + "T00:00:00").getTime()) matchDateCol = false;
          if (dateFilters.dia.max && item.diaVal !== 0 && item.diaVal > new Date(dateFilters.dia.max + "T23:59:59").getTime()) matchDateCol = false;
        }
        if (dateFilters.data_inic) {
          if (dateFilters.data_inic.min && item.dtInicVal && item.dtInicVal < new Date(dateFilters.data_inic.min + "T00:00:00").getTime()) matchDateCol = false;
          if (dateFilters.data_inic.max && item.dtInicVal && item.dtInicVal > new Date(dateFilters.data_inic.max + "T23:59:59").getTime()) matchDateCol = false;
        }
        if (dateFilters.data_fim) {
          if (dateFilters.data_fim.min && item.dtFimVal && item.dtFimVal < new Date(dateFilters.data_fim.min + "T00:00:00").getTime()) matchDateCol = false;
          if (dateFilters.data_fim.max && item.dtFimVal && item.dtFimVal > new Date(dateFilters.data_fim.max + "T23:59:59").getTime()) matchDateCol = false;
        }
        return matchContrato && matchSit && matchExistencia && matchMovimento && matchEmitente && matchUgNome && matchEmpenho && matchDocumento && matchObs && matchNum && matchDateCol && matchSecLog && matchGestor;
      });
      if (sortConfig.key) {
        filtered.sort((a, b) => {
          let valA = a[sortConfig.key],
            valB = b[sortConfig.key];
          if (sortConfig.key === 'data_inic') {
            valA = a.dtInicVal;
            valB = b.dtInicVal;
          } else if (sortConfig.key === 'data_fim') {
            valA = a.dtFimVal;
            valB = b.dtFimVal;
          }
          if (valA === null) valA = -Number.MAX_VALUE;
          if (valB === null) valB = -Number.MAX_VALUE;
          if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
          if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
          return 0;
        });
      }
      return filtered;
    }, [data, metricField, searchContrato, searchSituacao, searchExistencia, searchMovimento, searchEmitente, searchUgNome, searchEmpenho, searchDocumento, searchObs, searchSecLog, searchGestor, numFilters, dateFilters, sortConfig]);
    useEffect(() => {
      setLimit(100);
    }, [data, searchContrato, searchSituacao, searchExistencia, searchMovimento, searchEmitente, searchUgNome, searchEmpenho, searchDocumento, searchObs, searchSecLog, searchGestor, numFilters, dateFilters, sortConfig]);
    const totalMetric = useMemo(() => tableData.reduce((acc, curr) => acc + curr[metricField], 0), [tableData, metricField]);
    const getExportCols = () => {
      let cols = [];
      if (visibleCols.dia) cols.push({
        header: "DIA",
        key: "dia"
      });
      if (visibleCols.contrato) cols.push({
        header: "CONTRATO/COMPRA",
        key: "contrato",
        format: r => `${r.contrato}\nCompra: ${r.compra}\nMod: ${r.modalidade}`
      });
      if (visibleCols.arquivos) cols.push(...ContractFiles.exportColumns());
      if (visibleCols.sec_log) cols.push({
        header: "SEC LOG",
        key: "sec_log"
      });
      if (visibleCols.situacao) cols.push({
        header: "SITUAÇÃO",
        key: "situacao"
      });
      if (visibleCols.movimento) cols.push({
        header: "MOVIMENTO",
        key: "movimentoStr"
      });
      if (visibleCols.diasAss) cols.push({
        header: "DIAS ATÉ ASS. (RO)",
        key: "diasAss"
      });
      if (visibleCols.vigencia) {
        cols.push({
          header: "VIG. INIC",
          key: "data_inic"
        });
        cols.push({
          header: "VIG. FIM",
          key: "data_fim"
        });
      }
      if (visibleCols.perc_tempo) cols.push({
        header: "% TEMPO",
        key: "perc_tempo",
        isPercent: true
      });
      if (visibleCols.emitente) cols.push({
        header: "EMITENTE",
        key: "ug"
      });
      if (visibleCols.favorecido) cols.push({
        header: "FAVORECIDO",
        key: "favorecido"
      });
      if (visibleCols.objeto) cols.push({
        header: "OBJETO",
        key: "objeto"
      });
      if (visibleCols.gestor) {
        cols.push({
          header: "GESTOR",
          key: "gestor"
        });
        cols.push({
          header: "FISCAL",
          key: "fiscal"
        });
      }
      if (visibleCols.existencia) cols.push({
        header: "EXISTÊNCIA",
        key: "existencia"
      });
      if (visibleCols.empenho) cols.push({
        header: "EMPENHO",
        key: "empenho"
      });
      if (visibleCols.documento) cols.push({
        header: "DOCUMENTO",
        key: "documento"
      });
      if (visibleCols.obs) cols.push({
        header: "OBS",
        key: "obs"
      });
      if (visibleCols.metricas) cols.push({
        header: metricLabel,
        key: metricField,
        isCurrency: true
      });
      return cols;
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[500px]"
    }, /*#__PURE__*/React.createElement("div", {
      className: `${headerColor} px-4 py-3 flex justify-between items-center flex-wrap gap-2`
    }, /*#__PURE__*/React.createElement("h3", {
      className: "text-white text-xs font-black tracking-widest uppercase"
    }, title, " (", tableData.length, ")"), /*#__PURE__*/React.createElement("div", {
      className: "flex gap-2 items-center"
    }, /*#__PURE__*/React.createElement("div", {
      className: "relative"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setShowColsMenu(!showColsMenu),
      className: "bg-slate-700 hover:bg-slate-600 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
    }, "COLUNAS \u25BC"), showColsMenu && /*#__PURE__*/React.createElement("div", {
      className: "absolute right-0 mt-1 w-48 bg-white rounded shadow-lg border border-slate-200 z-50 p-2 flex flex-col gap-1 max-h-64 overflow-y-auto custom-scrollbar"
    }, Object.keys(visibleCols).map(k => /*#__PURE__*/React.createElement("label", {
      key: k,
      className: "flex items-center gap-2 text-[10px] font-bold text-slate-700 cursor-pointer hover:bg-slate-50 p-1 rounded"
    }, /*#__PURE__*/React.createElement("input", {
      type: "checkbox",
      checked: visibleCols[k],
      onChange: () => setVisibleCols(p => ({
        ...p,
        [k]: !p[k]
      }))
    }), k.toUpperCase())))), /*#__PURE__*/React.createElement("div", {
      className: "w-[1px] h-4 bg-slate-400 mx-1 hidden sm:block"
    }), /*#__PURE__*/React.createElement("button", {
      onClick: () => exportTable.toExcel(tableData, title, getExportCols()),
      className: "bg-green-600 hover:bg-green-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
    }, "EXCEL"), /*#__PURE__*/React.createElement("button", {
      onClick: () => exportTable.toCSV(tableData, title, getExportCols()),
      className: "bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
    }, "CSV"), /*#__PURE__*/React.createElement("button", {
      onClick: () => exportTable.toPDF(tableData, title, getExportCols(), title.toUpperCase()),
      className: "bg-red-600 hover:bg-red-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
    }, "PDF"))), /*#__PURE__*/React.createElement("div", {
      className: "overflow-x-auto overflow-y-auto flex-1 custom-scrollbar"
    }, /*#__PURE__*/React.createElement("table", {
      className: "text-left text-[9px] border-collapse relative",
      style: {
        tableLayout: 'fixed',
        width: '100%',
        minWidth: '1800px'
      }
    }, /*#__PURE__*/React.createElement("thead", {
      className: "bg-slate-50 sticky top-0 border-b border-slate-200 shadow-sm z-10"
    }, /*#__PURE__*/React.createElement("tr", {
      className: "text-slate-600 uppercase font-black tracking-tighter align-top"
    }, visibleCols.dia && /*#__PURE__*/React.createElement(DateFilterHeader, {
      widthClass: "w-[6%]",
      label: "DIA",
      field: "dia",
      current: sortConfig,
      onSort: handleSort,
      dateFilters: dateFilters,
      setDateFilters: setDateFilters
    }), visibleCols.contrato && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[8%]",
      label: "CONTRATO/COMPRA",
      field: "contrato",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchContrato,
      onSearchChange: setSearchContrato
    }), visibleCols.arquivos && /*#__PURE__*/React.createElement("th", {
      scope: "col",
      className: "w-[76px] min-w-[76px] p-2 align-top text-center sm:w-[140px] sm:min-w-[140px]"
    }, "ARQUIVOS"), visibleCols.sec_log && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[5%]",
      label: "SEC LOG",
      field: "sec_log",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchSecLog,
      onSearchChange: setSearchSecLog
    }), visibleCols.situacao && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[6%]",
      label: "SITUA\xC7\xC3O",
      field: "situacao",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchSituacao,
      onSearchChange: setSearchSituacao,
      align: "center"
    }), visibleCols.movimento && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[6%]",
      label: "MOVIMENTO",
      field: "movimentoStr",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchMovimento,
      onSearchChange: setSearchMovimento,
      align: "center"
    }), visibleCols.diasAss && /*#__PURE__*/React.createElement(NumericHeader, {
      widthClass: "w-[5%]",
      label: "DIAS ASS (RO)",
      field: "diasAss",
      current: sortConfig,
      onSort: handleSort,
      numFilters: numFilters,
      setNumFilters: setNumFilters,
      align: "center"
    }), visibleCols.vigencia && /*#__PURE__*/React.createElement(DateFilterHeader, {
      widthClass: "w-[6%]",
      label: "VIG\xCANCIA",
      field: "data_inic",
      current: sortConfig,
      onSort: handleSort,
      dateFilters: dateFilters,
      setDateFilters: setDateFilters,
      align: "center"
    }), visibleCols.perc_tempo && /*#__PURE__*/React.createElement(NumericHeader, {
      widthClass: "w-[7%]",
      label: "% TEMPO",
      field: "perc_tempo",
      current: sortConfig,
      onSort: handleSort,
      numFilters: numFilters,
      setNumFilters: setNumFilters,
      align: "center"
    }), visibleCols.emitente && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[6%]",
      label: "EMITENTE",
      field: "ug",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchEmitente,
      onSearchChange: setSearchEmitente
    }), visibleCols.favorecido && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[12%]",
      label: "FAVORECIDO",
      field: "favorecido",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchUgNome,
      onSearchChange: setSearchUgNome
    }), visibleCols.objeto && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[10%]",
      label: "OBJETO",
      field: "objeto",
      current: sortConfig,
      onSort: handleSort
    }), visibleCols.gestor && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[7%]",
      label: "GESTOR/FISCAL",
      field: "gestor",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchGestor,
      onSearchChange: setSearchGestor
    }), visibleCols.existencia && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[6%]",
      label: "EXIST\xCANCIA",
      field: "existencia",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchExistencia,
      onSearchChange: setSearchExistencia,
      align: "center"
    }), visibleCols.empenho && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[8%]",
      label: "EMPENHO",
      field: "empenho",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchEmpenho,
      onSearchChange: setSearchEmpenho
    }), visibleCols.documento && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[8%]",
      label: "DOCUMENTO",
      field: "documento",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchDocumento,
      onSearchChange: setSearchDocumento
    }), visibleCols.obs && /*#__PURE__*/React.createElement(TextHeader, {
      widthClass: "w-[15%]",
      label: "OBS",
      field: "obs",
      current: sortConfig,
      onSort: handleSort,
      searchVal: searchObs,
      onSearchChange: setSearchObs
    }), visibleCols.metricas && /*#__PURE__*/React.createElement(NumericHeader, {
      widthClass: "w-[10%]",
      label: metricLabel,
      field: metricField,
      current: sortConfig,
      onSort: handleSort,
      numFilters: numFilters,
      setNumFilters: setNumFilters,
      align: "right"
    }))), /*#__PURE__*/React.createElement("tbody", {
      className: "divide-y divide-slate-100"
    }, tableData.slice(0, limit).map((row, i) => /*#__PURE__*/React.createElement("tr", {
      key: i,
      className: "hover:bg-blue-50 transition-colors"
    }, visibleCols.dia && /*#__PURE__*/React.createElement("td", {
      className: "p-2 text-slate-500 font-bold whitespace-normal break-words"
    }, row.dia || "-"), visibleCols.contrato && /*#__PURE__*/React.createElement("td", {
      className: "p-2 align-top min-w-[150px]"
    }, /*#__PURE__*/React.createElement(ContratoCell, {
      row: row
    })), visibleCols.arquivos && /*#__PURE__*/React.createElement("td", {
      className: "p-2 align-top"
    }, /*#__PURE__*/React.createElement(ContractFilesCell, {
      row: row
    })), visibleCols.sec_log && /*#__PURE__*/React.createElement("td", {
      className: "p-2 text-slate-500 font-bold whitespace-normal break-words"
    }, row.sec_log), visibleCols.situacao && /*#__PURE__*/React.createElement("td", {
      className: "p-2 align-middle text-center"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center justify-center gap-1"
    }, row.situacaoFlags && row.situacaoFlags.map((f, idx) => /*#__PURE__*/React.createElement("span", {
      key: idx,
      className: `text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${f.color}`
    }, f.label)))), visibleCols.movimento && /*#__PURE__*/React.createElement("td", {
      className: "p-2 align-middle text-center"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap items-center justify-center gap-1"
    }, row.movimentoFlags && row.movimentoFlags.map((f, idx) => /*#__PURE__*/React.createElement("span", {
      key: idx,
      className: `text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${f.color}`
    }, f.label)))), visibleCols.diasAss && /*#__PURE__*/React.createElement("td", {
      className: "p-2 align-middle text-center font-bold text-slate-600"
    }, row.diasAss !== null ? /*#__PURE__*/React.createElement("span", {
      className: `px-1.5 py-0.5 rounded ${row.diasAss >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`
    }, row.diasAss, " d") : "-"), visibleCols.vigencia && /*#__PURE__*/React.createElement("td", {
      className: "p-2 text-slate-500 font-bold whitespace-normal break-words text-center"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[9px] text-slate-400"
    }, "In\xED: ", row.data_inic || "-"), /*#__PURE__*/React.createElement("div", {
      className: "text-[9px] mt-1 text-slate-600"
    }, "Fim: ", row.data_fim || "-")), visibleCols.perc_tempo && /*#__PURE__*/React.createElement("td", {
      className: "p-2 align-middle"
    }, row.perc_tempo !== null ? /*#__PURE__*/React.createElement("div", {
      className: "flex flex-col gap-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-[8px] font-bold text-slate-500 text-center"
    }, row.dias_passaram, " d decorridos"), /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-full bg-slate-200 rounded-full h-1.5 flex-1 overflow-hidden"
    }, /*#__PURE__*/React.createElement("div", {
      className: `h-1.5 rounded-full ${row.perc_tempo >= 1 ? 'bg-red-500' : 'bg-emerald-500'}`,
      style: {
        width: `${Math.min(Math.max(row.perc_tempo * 100, 0), 100)}%`
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "text-[8px] font-bold text-slate-600 min-w-[30px] text-right"
    }, formatPercentBR(row.perc_tempo))), /*#__PURE__*/React.createElement("div", {
      className: "text-[8px] font-bold text-center mt-0.5"
    }, /*#__PURE__*/React.createElement("span", {
      className: row.encerrando_dias < 0 ? 'text-red-500' : 'text-emerald-600'
    }, row.encerrando_dias, " d restantes"))) : "-"), visibleCols.emitente && /*#__PURE__*/React.createElement("td", {
      className: "p-2 font-bold text-slate-700 whitespace-normal break-words"
    }, row.ug), visibleCols.favorecido && /*#__PURE__*/React.createElement("td", {
      className: "p-2 text-slate-600 font-bold whitespace-normal break-words leading-tight"
    }, /*#__PURE__*/React.createElement(CounterpartyLink, {
      name: row.favorecido,
      identifier: row.favorecido_cnpj,
      title: "Abrir favorecido no Portal da Transpar\xEAncia"
    })), visibleCols.objeto && /*#__PURE__*/React.createElement("td", {
      className: "p-2 text-slate-500 whitespace-normal break-words leading-tight"
    }, row.objeto), visibleCols.gestor && /*#__PURE__*/React.createElement("td", {
      className: "p-2 whitespace-normal break-words"
    }, /*#__PURE__*/React.createElement("div", {
      className: "font-bold text-slate-700",
      title: "Gestor"
    }, "G: ", row.gestor), /*#__PURE__*/React.createElement("div", {
      className: "font-bold text-slate-700 mt-1",
      title: "Fiscal"
    }, "F: ", row.fiscal)), visibleCols.existencia && /*#__PURE__*/React.createElement("td", {
      className: "p-2 align-middle text-center"
    }, /*#__PURE__*/React.createElement("span", {
      className: `text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${row.existencia === 'AMBAS' ? 'bg-blue-100 text-blue-700 border border-blue-200' : row.existencia === 'GERAL' ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-orange-100 text-orange-800 border border-orange-200'}`
    }, row.existencia)), visibleCols.empenho && /*#__PURE__*/React.createElement("td", {
      className: "p-2 text-slate-600 font-bold whitespace-normal break-words"
    }, row.empenho && /*#__PURE__*/React.createElement(PortalDocumentLink, {
      value: row.empenho,
      context: row
    })), visibleCols.documento && /*#__PURE__*/React.createElement("td", {
      className: "p-2 text-slate-600 font-bold whitespace-normal break-words"
    }, row.documento && /*#__PURE__*/React.createElement(PortalDocumentLink, {
      value: row.documento,
      context: row
    })), visibleCols.obs && /*#__PURE__*/React.createElement("td", {
      className: "p-2 text-slate-500 whitespace-normal break-words leading-tight"
    }, row.obs), visibleCols.metricas && /*#__PURE__*/React.createElement("td", {
      className: `p-2 text-right font-black whitespace-normal break-words ${textColor} ${rowBgColor}`,
      "data-metric": MetricColors.key(metricField),
      style: MetricColors.textStyle(metricField)
    }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
      val: row[metricField]
    }))))), /*#__PURE__*/React.createElement("tfoot", {
      className: "bg-slate-200 sticky bottom-0 border-t-2 border-slate-300 shadow-md z-10"
    }, /*#__PURE__*/React.createElement("tr", {
      className: "text-slate-700 uppercase font-black"
    }, Object.entries(visibleCols).some(_ref50 => {
      let [key, shown] = _ref50;
      return shown && key !== 'metricas';
    }) && /*#__PURE__*/React.createElement("td", {
      colSpan: Object.entries(visibleCols).filter(_ref51 => {
        let [key, shown] = _ref51;
        return shown && key !== 'metricas';
      }).length,
      className: "p-2 text-right"
    }, "TOTAL DA M\xC9TRICA:"), visibleCols.metricas && /*#__PURE__*/React.createElement("td", {
      className: `p-2 text-right ${textColor}`,
      "data-metric": MetricColors.key(metricField),
      style: MetricColors.textStyle(metricField)
    }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
      val: totalMetric
    })))))), limit < tableData.length && /*#__PURE__*/React.createElement("div", {
      className: "p-2 bg-slate-50 border-t flex justify-center"
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setLimit(prev => prev + 100),
      className: "bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-[10px] px-4 py-1 rounded transition"
    }, "Ver mais (+100)")));
  }

  // =========================================================
  // DASHBOARD MASTER CONTÁBIL
  // =========================================================
  function useDashboard(_ref52) {
    let {
      payload,
      shared,
      rawContracts,
      activePage,
      globalExpandState,
      expandTrigger,
      resetRevision
    } = _ref52;
    const [rawData, setRawData] = useState([]);
    const [processedPayload, setProcessedPayload] = useState(null);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState("Aguardando sincronização. Clique em SINCRONIZAR APIs para carregar os dados.");
    const [sortConfig, setSortConfig] = useState({
      key: 'diaVal',
      direction: 'desc'
    });

    // Estado de Expansão Global

    const [top20Sort, setTop20Sort] = useState('emp_desc');
    const [top20ViewMode, setTop20ViewMode] = useState('favorecido');
    const [top20100Sort, setTop20100Sort] = useState('emp_desc');
    const [top20100ViewMode, setTop20100ViewMode] = useState('favorecido');
    const fSituacaoTags = shared.fSituacaoTags;
    const [fExistencia, setFExistencia] = useState([]);
    const [fMovimento, setFMovimento] = useState([]);
    const [fUg, setFUg] = useState([]);
    const [fFavorecido, setFFavorecido] = useState([]);
    const [fEmpenho, setFEmpenho] = useState([]);
    const [fDocumento, setFDocumento] = useState([]);
    const fContrato = shared.fContrato;
    const fFiscal = shared.fFiscal;
    const fGestor = shared.fGestor;
    const fFiscalSub = shared.fFiscalSub;
    const fGestorSub = shared.fGestorSub;
    const fSecLog = shared.fSecLog;
    const fCompra = shared.fCompra;
    const fModalidade = shared.fModalidade;
    const fAoCodigo = shared.fAoCodigo;
    const fAoNome = shared.fAoNome;
    const fPoCodigo = shared.fPoCodigo;
    const fPoNome = shared.fPoNome;
    const fPtres = shared.fPtres;
    const fPiCod = shared.fPiCod;
    const fPiNome = shared.fPiNome;
    const fNdCodigo = shared.fNdCodigo;
    const fNdNome = shared.fNdNome;
    const [dDiaDe, setDDiaDe] = useState("");
    const [dDiaAte, setDDiaAte] = useState("");
    const dInicDe = shared.dInicDe;
    const dInicAte = shared.dInicAte;
    const dFimDe = shared.dFimDe;
    const dFimAte = shared.dFimAte;
    const [searchContratoTabela, setSearchContratoTabela] = useState("");
    const [searchSituacaoTabela, setSearchSituacaoTabela] = useState("");
    const [searchExistenciaTabela, setSearchExistenciaTabela] = useState("");
    const [searchMovimentoTabela, setSearchMovimentoTabela] = useState("");
    const [searchEmitenteTabela, setSearchEmitenteTabela] = useState("");
    const [searchUgNome, setSearchUgNome] = useState("");
    const [searchEmpenho, setSearchEmpenho] = useState("");
    const [searchDocumento, setSearchDocumento] = useState("");
    const [searchObs, setSearchObs] = useState("");
    const [searchObjeto, setSearchObjeto] = useState("");
    const [searchGestorTabela, setSearchGestorTabela] = useState("");
    const [searchSecLogTabela, setSearchSecLogTabela] = useState("");
    const [fOnlyBloqueado, setFOnlyBloqueado] = useState(false);
    const [fOnlyCancelado, setFOnlyCancelado] = useState(false);
    const [visibleRows, setVisibleRows] = useState(100);

    // Controle Dinâmico da Tabela Master
    const [showMasterColsMenu, setShowMasterColsMenu] = useState(false);
    const [masterCols, setMasterCols] = useState({
      dia: true,
      contrato: true,
      arquivos: true,
      sec_log: true,
      situacao: true,
      movimento: true,
      diasAss: true,
      vigencia: true,
      perc_tempo: true,
      emitente: true,
      favorecido: true,
      objeto: true,
      gestor: true,
      existencia: true,
      empenho: true,
      documento: true,
      obs: true,
      v_emp: true,
      v_rec: true,
      v_liq: true,
      v_pag: true,
      v_can: true,
      v_bloq: true
    });
    const [areaAggLevel, setAreaAggLevel] = useState('mes');
    const [barAggLevel, setBarAggLevel] = useState('mes');
    const [areaXAxisMode, setAreaXAxisMode] = useState('nao_normalizada');
    const [barXAxisMode, setBarXAxisMode] = useState('nao_normalizada');
    const [matrixGroupBy, setMatrixGroupBy] = useState('contrato_empenho');
    const [matrixSort, setMatrixSort] = useState({
      key: 'sortVal',
      direction: 'asc'
    });
    const [matrixLimit, setMatrixLimit] = useState(100);
    const [matrixVisibleCols, setMatrixVisibleCols] = useState({
      emp: true,
      rec: true,
      liq: true,
      pag: true,
      bloq: true,
      can: true,
      saldo: true
    });
    const [showMatrixCols, setShowMatrixCols] = useState(false);
    const initialNumFilters = {
      v_empenhado: {
        min: '',
        max: ''
      },
      v_recebido: {
        min: '',
        max: ''
      },
      v_liquidado: {
        min: '',
        max: ''
      },
      v_pago: {
        min: '',
        max: ''
      },
      v_cancelado: {
        min: '',
        max: ''
      },
      v_bloqueado: {
        min: '',
        max: ''
      },
      perc_tempo: {
        min: '',
        max: ''
      },
      diasAss: {
        min: '',
        max: ''
      }
    };
    const [numFilters, setNumFilters] = useState(initialNumFilters);
    const [dateFilters, setDateFilters] = useState({
      dia: {
        min: '',
        max: ''
      },
      data_inic: {
        min: '',
        max: ''
      },
      data_fim: {
        min: '',
        max: ''
      }
    });
    const handleSort = key => setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
    const handleMatrixSort = key => setMatrixSort(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
    const toggleExistencia = val => {
      setFExistencia(prev => prev.includes(val) ? prev.filter(x => x !== val) : [...prev, val]);
    };
    const toggleMovimento = val => {
      setFMovimento(prev => prev.includes(val) ? prev.filter(x => x !== val) : [...prev, val]);
    };
    const todayD = new Date();
    const ts = `${todayD.getFullYear()}-${String(todayD.getMonth() + 1).padStart(2, '0')}-${String(todayD.getDate()).padStart(2, '0')}`;
    const p7Doc = new Date();
    p7Doc.setDate(todayD.getDate() - 7);
    const ps7Doc = `${p7Doc.getFullYear()}-${String(p7Doc.getMonth() + 1).padStart(2, '0')}-${String(p7Doc.getDate()).padStart(2, '0')}`;
    const p30Doc = new Date();
    p30Doc.setDate(todayD.getDate() - 30);
    const ps30Doc = `${p30Doc.getFullYear()}-${String(p30Doc.getMonth() + 1).padStart(2, '0')}-${String(p30Doc.getDate()).padStart(2, '0')}`;
    const f7Contr = new Date();
    f7Contr.setDate(todayD.getDate() + 7);
    const fs7Contr = `${f7Contr.getFullYear()}-${String(f7Contr.getMonth() + 1).padStart(2, '0')}-${String(f7Contr.getDate()).padStart(2, '0')}`;
    const f30Contr = new Date();
    f30Contr.setDate(todayD.getDate() + 30);
    const fs30Contr = `${f30Contr.getFullYear()}-${String(f30Contr.getMonth() + 1).padStart(2, '0')}-${String(f30Contr.getDate()).padStart(2, '0')}`;
    const isDoc7DiasActive = dDiaDe === ps7Doc && dDiaAte === ts;
    const isDoc30DiasActive = dDiaDe === ps30Doc && dDiaAte === ts;
    const toggleDoc7Dias = () => {
      if (isDoc7DiasActive) {
        setDDiaDe("");
        setDDiaAte("");
      } else {
        setDDiaDe(ps7Doc);
        setDDiaAte(ts);
      }
    };
    const toggleDoc30Dias = () => {
      if (isDoc30DiasActive) {
        setDDiaDe("");
        setDDiaAte("");
      } else {
        setDDiaDe(ps30Doc);
        setDDiaAte(ts);
      }
    };
    useEffect(() => {
      setVisibleRows(100);
    }, [fExistencia, fMovimento, fUg, fFavorecido, fEmpenho, fDocumento, fContrato, fFiscal, fGestor, fFiscalSub, fGestorSub, fSecLog, fCompra, fModalidade, fAoCodigo, fAoNome, fPoCodigo, fPoNome, fPtres, fPiCod, fPiNome, fNdCodigo, fNdNome, dDiaDe, dDiaAte, dInicDe, dInicAte, dFimDe, dFimAte, fSituacaoTags, searchContratoTabela, searchSituacaoTabela, searchExistenciaTabela, searchMovimentoTabela, searchEmitenteTabela, searchUgNome, searchEmpenho, searchDocumento, searchObs, searchObjeto, searchGestorTabela, searchSecLogTabela, numFilters, dateFilters, sortConfig]);
    useEffect(() => {
      setMatrixLimit(100);
    }, [matrixGroupBy, matrixSort, searchContratoTabela, fExistencia, fUg, fContrato]);
    const clearLocalFilters = () => {
      setFUg([]);
      setFFavorecido([]);
      setFEmpenho([]);
      setFDocumento([]);
      setFExistencia([]);
      setFMovimento([]);
      setDDiaDe("");
      setDDiaAte("");
      setSearchContratoTabela("");
      setSearchSituacaoTabela("");
      setSearchExistenciaTabela("");
      setSearchMovimentoTabela("");
      setSearchEmitenteTabela("");
      setSearchUgNome("");
      setSearchEmpenho("");
      setSearchDocumento("");
      setSearchObs("");
      setSearchObjeto("");
      setSearchGestorTabela("");
      setSearchSecLogTabela("");
      setNumFilters(initialNumFilters);
      setDateFilters({
        dia: {
          min: '',
          max: ''
        },
        data_inic: {
          min: '',
          max: ''
        },
        data_fim: {
          min: '',
          max: ''
        }
      });
      setFOnlyBloqueado(false);
      setFOnlyCancelado(false);
    };
    useEffect(() => {
      clearLocalFilters();
    }, [resetRevision]);
    const maxDateInfo = useMemo(() => {
      if (!rawData || rawData.length === 0) return {
        val: null,
        str: "",
        iso: ""
      };
      let maxVal = -1;
      let maxStr = "";
      let maxIso = "";
      rawData.forEach(item => {
        if (item.diaVal > maxVal) {
          maxVal = item.diaVal;
          maxStr = item.dia;
          const d = new Date(item.diaVal);
          maxIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
      });
      return {
        val: maxVal,
        str: maxStr,
        iso: maxIso
      };
    }, [rawData]);
    const isUltimoDiaActive = !!maxDateInfo.iso && dDiaDe === maxDateInfo.iso && dDiaAte === maxDateInfo.iso;
    const applyFilterUltimoDia = () => {
      if (isUltimoDiaActive) {
        setDDiaDe("");
        setDDiaAte("");
      } else if (maxDateInfo.iso) {
        setDDiaDe(maxDateInfo.iso);
        setDDiaAte(maxDateInfo.iso);
      }
    };
    const processMergedData = function (contabilRows) {
      let geralRows = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
      let orcamentarioRows = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : [];
      contabilRows = contabilRows && contabilRows.length ? contabilRows : [[]];
      setStatus("A estruturar matriz de relacionamento de dados...");
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const orcamentarioDict = {};
      const orcamentarioDocumentoDict = {};
      if (orcamentarioRows && orcamentarioRows.length > 1) {
        const hOrc = orcamentarioRows[0];
        const mapOrc = {};
        hOrc.forEach((h, i) => {
          if (h) mapOrc[normalizeStr(h)] = i;
        });
        const getVO = (names, kws, row) => {
          for (let name of names) {
            const n = normalizeStr(name);
            if (mapOrc[n] !== undefined) {
              const v = row[mapOrc[n]];
              return v !== undefined && v !== null ? v.toString().trim() : "";
            }
          }
          for (let kw of kws) {
            const nKw = normalizeStr(kw);
            const foundKey = Object.keys(mapOrc).find(k => k.includes(nKw));
            if (foundKey) {
              const v = row[mapOrc[foundKey]];
              return v !== undefined && v !== null ? v.toString().trim() : "";
            }
          }
          return "";
        };
        const addOrcValue = (target, key, value) => {
          const clean = (value || '').toString().trim().toUpperCase();
          if (clean && clean !== '-') clean.split(/\s*;\s*/).filter(Boolean).forEach(value => target[key].add(value));
        };
        const createOrcAccumulator = () => ({
          ao_codigo_values: new Set(),
          ao_nome_values: new Set(),
          po_codigo_values: new Set(),
          po_nome_values: new Set(),
          ptres_values: new Set(),
          pi_cod_values: new Set(),
          pi_nome_values: new Set(),
          nd_codigo_values: new Set(),
          nd_nome_values: new Set()
        });
        for (let i = 1; i < orcamentarioRows.length; i++) {
          const row = orcamentarioRows[i];
          if (!row || !row.length) continue;
          const contrato = getVO(["COL_NR_CONTR_BASE", "Contrato", "Número Contrato", "Numero Contrato"], ["contr base", "contrato"], row).toUpperCase();
          const documentoCcor = getVO(["Documento CCor Número", "Documento CCor Numero", "DOCUMENTO_CCOR_NUMERO"], ["documento ccor"], row).toUpperCase();
          if (!contrato || contrato === '-') continue;
          if (!orcamentarioDict[UnifiedData.key(contrato)]) {
            orcamentarioDict[UnifiedData.key(contrato)] = createOrcAccumulator();
          }
          const targets = [orcamentarioDict[UnifiedData.key(contrato)]];
          if (documentoCcor && documentoCcor !== '-') {
            const documentKey = `${UnifiedData.key(contrato)}|${UnifiedData.key(documentoCcor)}`;
            if (!orcamentarioDocumentoDict[documentKey]) orcamentarioDocumentoDict[documentKey] = createOrcAccumulator();
            targets.push(orcamentarioDocumentoDict[documentKey]);
          }
          targets.forEach(target => {
            addOrcValue(target, 'ao_codigo_values', getVO(["Ação Governo Código"], ["acao governo codigo"], row));
            addOrcValue(target, 'ao_nome_values', getVO(["Ação Governo Nome"], ["acao governo nome"], row));
            addOrcValue(target, 'po_codigo_values', getVO(["Plano Orçamentário Código PO"], ["plano orcamentario codigo po"], row));
            addOrcValue(target, 'po_nome_values', getVO(["Plano Orçamentário Nome"], ["plano orcamentario nome"], row));
            addOrcValue(target, 'ptres_values', getVO(["PTRES Código"], ["ptres codigo", "ptres"], row));
            addOrcValue(target, 'pi_cod_values', getVO(["PI Código PI"], ["pi codigo pi"], row));
            addOrcValue(target, 'pi_nome_values', getVO(["PI Nome"], ["pi nome"], row));
            addOrcValue(target, 'nd_codigo_values', getVO(["ND_DOC"], ["nd doc"], row));
            addOrcValue(target, 'nd_nome_values', getVO(["ND_NOME"], ["nd nome"], row));
          });
        }
        [orcamentarioDict, orcamentarioDocumentoDict].forEach(dictionary => {
          Object.keys(dictionary).forEach(dictionaryKey => {
            Object.keys(dictionary[dictionaryKey]).forEach(key => {
              dictionary[dictionaryKey][key] = [...dictionary[dictionaryKey][key]].sort();
            });
          });
        });
      }
      const emptyOrcamentario = () => ({
        ao_codigo_values: [],
        ao_nome_values: [],
        po_codigo_values: [],
        po_nome_values: [],
        ptres_values: [],
        pi_cod_values: [],
        pi_nome_values: [],
        nd_codigo_values: [],
        nd_nome_values: []
      });
      const ledgerByContract = (payload === null || payload === void 0 ? void 0 : payload.ledgerIndex) || ContractRules.accountingBalances(contabilRows);
      const filesByContract = ContractFiles.index(geralRows);
      const canonicalContracts = new Map();
      rawContracts.forEach(row => {
        const id = UnifiedData.key(row.contrato);
        if (!canonicalContracts.has(id)) canonicalContracts.set(id, row);
      });
      const geralDict = {};
      if (geralRows && geralRows.length > 1) {
        const hGeral = geralRows[0];
        const mapG = {};
        hGeral.forEach((h, i) => {
          if (h) mapG[normalizeStr(h)] = i;
        });
        const getVG = (names, kws, row) => {
          for (let name of names) {
            let n = normalizeStr(name);
            if (mapG[n] !== undefined) {
              let v = row[mapG[n]];
              return v !== undefined && v !== null ? v.toString().trim() : "";
            }
          }
          for (let kw of kws) {
            let nKw = normalizeStr(kw);
            let foundKey = Object.keys(mapG).find(k => k.includes(nKw));
            if (foundKey) {
              let v = row[mapG[foundKey]];
              return v !== undefined && v !== null ? v.toString().trim() : "";
            }
          }
          return "";
        };
        for (let i = 1; i < geralRows.length; i++) {
          const row = geralRows[i];
          if (!row || !row.length) continue;
          const contrato = getVG(["Número Contrato", "numero_contrato"], ["contrato"], row).toUpperCase();
          if (!contrato || contrato === "-" || geralDict[UnifiedData.key(contrato)]) continue;
          const v_empenhado_g = parseValue(getVG(["TOTAL EMPENHADO"], [], row));
          const v_global_g = parseValue(getVG(["VALOR GLOBAL", "TOTAL GLOBAL", "Valor Global do Contrato", "VALOR_GLOBAL", "Valor Global (R$)"], ["valor global", "total global", "global contrato"], row));
          const v_liquidado_g = parseValue(getVG(["TOTAL LIQUIDADO"], [], row));
          const v_pago_g = parseValue(getVG(["TOTAL PAGO"], [], row));
          const v_executado_g = parseValue(getVG(["TOTAL EXECUTADO"], [], row));
          const v_bloqueado_g = parseValue(getVG(["TOTAL BLOQUEADO"], [], row));
          const v_cancelado_g = parseValue(getVG(["TOTAL CANCELADO"], [], row));
          const dtInicParsed = parseDateBR(getVG(["Vig. Início", "Vigencia Inicio"], [], row));
          const dtFimParsed = parseDateBR(getVG(["Vig. Fim", "Vigencia Fim"], [], row));
          let diasRestantes = null,
            diasPassaram = null,
            percTempo = null;
          if (dtFimParsed) diasRestantes = Math.ceil((dtFimParsed - hoje) / 86400000);
          if (dtInicParsed) diasPassaram = Math.ceil((hoje - dtInicParsed) / 86400000);
          if (dtInicParsed && dtFimParsed) {
            const totalDias = Math.ceil((dtFimParsed - dtInicParsed) / 86400000);
            percTempo = totalDias > 0 ? diasPassaram / totalDias : 0;
          }
          const received = ledgerByContract.get(UnifiedData.key(contrato));
          const canonicalContract = canonicalContracts.get(UnifiedData.key(contrato));
          const classification = canonicalContract ? {
            labels: canonicalContract.situacaoFlags.map(flag => flag.label)
          } : ContractRules.classify({
            v_empenhado: v_empenhado_g,
            v_recebido: (received === null || received === void 0 ? void 0 : received.v_recebido) || 0,
            v_liquidado: v_liquidado_g,
            v_pago: v_pago_g,
            v_cancelado: v_cancelado_g,
            v_bloqueado: v_bloqueado_g
          }, {
            dtInicVal: dtInicParsed === null || dtInicParsed === void 0 ? void 0 : dtInicParsed.getTime(),
            dtFimVal: dtFimParsed === null || dtFimParsed === void 0 ? void 0 : dtFimParsed.getTime()
          }, received === null || received === void 0 ? void 0 : received.hasMovement, hoje);
          const flags = classification.labels.map(label => ({
            label,
            color: tagColorsMap[label].css,
            hex: tagColorsMap[label].hex
          }));
          const sitText = classification.labels.join(' ');
          geralDict[UnifiedData.key(contrato)] = {
            contrato,
            files: filesByContract.get(UnifiedData.key(contrato)) || ContractFiles.empty,
            fornecedor: getVG(["Fornecedor"], [], row).toUpperCase() || "N/I",
            fiscal: getVG(["FISCAL_TITULAR", "Fiscal Titular"], ["fiscal"], row).toUpperCase() || "N/I",
            gestor: getVG(["GESTOR_TITULAR", "Gestor Titular"], ["gestor"], row).toUpperCase() || "N/I",
            fiscal_sub: getVG(["FISCAL_SUBSTITUTO", "Fiscal Substituto"], ["fiscal sub"], row).toUpperCase() || "N/I",
            gestor_sub: getVG(["GESTOR_SUBSTITUTO", "Gestor Substituto"], ["gestor sub"], row).toUpperCase() || "N/I",
            sec_log: getVG(["SEC_LOG"], ["sec log"], row).toUpperCase() || "N/I",
            modalidade: getVG(["Modalidade da Compra", "Modalidade"], ["modalidade"], row).toUpperCase() || "N/I",
            compra: getVG(["Número da Compra", "Numero da Compra", "Número Compra", "Numero Compra"], ["compra"], row).toUpperCase() || "N/I",
            objeto: getVG(["Objeto"], [], row).toUpperCase() || "-",
            data_inic: getVG(["Vig. Início", "Vigencia Inicio"], [], row),
            data_fim: getVG(["Vig. Fim", "Vigencia Fim"], [], row),
            dtInicVal: dtInicParsed ? dtInicParsed.getTime() : null,
            dtFimVal: dtFimParsed ? dtFimParsed.getTime() : null,
            dias_passaram: diasPassaram,
            perc_tempo: percTempo,
            encerrando_dias: diasRestantes,
            contract_metadata: canonicalContract === null || canonicalContract === void 0 ? void 0 : canonicalContract.contract_metadata,
            contract_metadata_conflicts: (canonicalContract === null || canonicalContract === void 0 ? void 0 : canonicalContract.contract_metadata_conflicts) || [],
            situacaoFlags: flags,
            situacao: sitText.trim() || 'N/I',
            v_global: v_global_g
          };
        }
      }
      const headersContabil = contabilRows[0];
      const hMapC = {};
      headersContabil.forEach((h, i) => {
        if (h) hMapC[normalizeStr(h)] = i;
      });
      const getVC = (exactNames, fallbackKeywords, row) => {
        for (let name of exactNames) {
          let n = normalizeStr(name);
          if (hMapC[n] !== undefined) {
            let v = row[hMapC[n]];
            return v !== undefined && v !== null ? v.toString().trim() : "";
          }
        }
        for (let kw of fallbackKeywords) {
          let nKw = normalizeStr(kw);
          let foundKey = Object.keys(hMapC).find(k => k.includes(nKw));
          if (foundKey) {
            let v = row[hMapC[foundKey]];
            return v !== undefined && v !== null ? v.toString().trim() : "";
          }
        }
        return "";
      };
      const grouped = {};
      const contratosEncontrados = new Set();
      const minRoDict = {};
      for (let i = 1; i < contabilRows.length; i++) {
        const row = contabilRows[i];
        if (!row || row.length === 0) continue;
        const dia = getVC(["Emissão - Dia Data Completa", "Emissao"], ["emissao", "dia", "data"], row);
        const ug = getVC(["Emitente - UG Código", "UG Codigo"], ["ug codigo", "emitente"], row).toUpperCase();
        const portalUg = ["Emitente - UG Código", "Emitente - UG Codigo", "UG Emitente Código", "UG Emitente Codigo", "UG Emitente", "UG Código", "UG Codigo"].map(name => getVC([name], [], row)).find(value => /^\d{1,6}$/.test(String(value || "").trim())) || "";
        const gestao = ["Emitente - Gestão Código", "Emitente - Gestao Codigo", "Emitente - Gestão", "Emitente - Gestao", "UG Emitente - Gestão Código", "UG Emitente - Gestao Codigo", "Gestão Código", "Gestao Codigo", "Gestão", "Gestao"].map(name => getVC([name], [], row)).find(value => /^\d{1,5}$/.test(String(value || "").trim())) || "";
        const fav = getVC(["Favorecido Doc. Nome", "Favorecido"], ["favorecido", "doc. nome"], row).toUpperCase();
        const favCnpj = getFornecedorCnpj(fav) || ["Favorecido Doc. Código", "Favorecido Doc. Codigo", "Favorecido Doc. CNPJ", "Favorecido CNPJ", "CNPJ Favorecido"].map(name => getFornecedorCnpj(getVC([name], [], row))).find(Boolean) || "";
        const empenho = getVC(["Documento CCor Número"], ["ccor", "empenho"], row).toUpperCase();
        const doc = getVC(["Documento Número"], ["documento numero", "doc numero"], row).toUpperCase();
        const obs = getVC(["Doc - Observação Texto", "Observação"], ["observacao", "obs"], row).toUpperCase();
        const contrato = getVC(["COL_NR_CONTR_BASE", "Contrato"], ["contr_base", "contrato"], row).toUpperCase();
        if (contrato && contrato !== "-") contratosEncontrados.add(UnifiedData.key(contrato));
        let info = getVC(["ITEM_INFORMACAO", "INTEN_INFORMACAO", "Informacao"], ["informacao", "item_in", "inten_in"], row).toUpperCase();
        let valStr = getVC(["Valor Item (R$)", "Valor (R$)", "Valor"], ["valor", "vlr", "r$", "montante", "saldo"], row);
        if (!info) {
          const rowStr = row.join(" ").toUpperCase();
          if (rowStr.includes("EMPENHADO")) info = "EMPENHADO";else if (rowStr.includes("RECEBIDO")) info = "RECEBIDO";else if (rowStr.includes("LIQUIDADO")) info = "LIQUIDADO";else if (rowStr.includes("PAGO")) info = "PAGO";else if (rowStr.includes("CANCELADO")) info = "CANCELADO";else if (rowStr.includes("BLOQUEADO")) info = "BLOQUEADO";
        }
        if (!valStr && row.length > 0) {
          for (let c = row.length - 1; c >= 0; c--) {
            let t = parseValue(row[c]);
            if (t !== 0) {
              valStr = row[c];
              break;
            }
          }
        }
        const valor = parseValue(valStr);
        const diaParsed = parseDateBR(dia);
        const diaVal = diaParsed ? diaParsed.getTime() : 0;
        const key = `${dia}|${ug}|${gestao}|${fav}|${favCnpj}|${empenho}|${doc}|${contrato}`;
        if (doc.includes("RO") && diaVal > 0 && contrato !== "-") {
          const keyRE = `${UnifiedData.key(contrato)}|${UnifiedData.key(empenho)}`;
          if (!minRoDict[keyRE] || diaVal < minRoDict[keyRE]) minRoDict[keyRE] = diaVal;
        }
        if (!grouped[key]) {
          const metadadosContrato = geralDict[UnifiedData.key(contrato)];
          const metadadosOrcamentarios = orcamentarioDocumentoDict[`${UnifiedData.key(contrato)}|${UnifiedData.key(empenho)}`] || emptyOrcamentario();
          grouped[key] = {
            dia,
            diaVal,
            ug,
            gestao,
            portal_ug: portalUg,
            portal_contexts: [{
              ug: portalUg,
              gestao
            }],
            favorecido: fav,
            favorecido_cnpj: favCnpj,
            empenho,
            documento: doc,
            obs,
            contrato: metadadosContrato ? metadadosContrato.contrato : contrato,
            ...metadadosOrcamentarios,
            fiscal: metadadosContrato ? metadadosContrato.fiscal : 'N/I',
            gestor: metadadosContrato ? metadadosContrato.gestor : 'N/I',
            fiscal_sub: metadadosContrato ? metadadosContrato.fiscal_sub : 'N/I',
            gestor_sub: metadadosContrato ? metadadosContrato.gestor_sub : 'N/I',
            sec_log: metadadosContrato ? metadadosContrato.sec_log : 'N/I',
            modalidade: metadadosContrato ? metadadosContrato.modalidade : 'N/I',
            compra: metadadosContrato ? metadadosContrato.compra : 'N/I',
            v_global: metadadosContrato ? metadadosContrato.v_global : 0,
            files: (metadadosContrato === null || metadadosContrato === void 0 ? void 0 : metadadosContrato.files) || ContractFiles.empty,
            contract_metadata: metadadosContrato === null || metadadosContrato === void 0 ? void 0 : metadadosContrato.contract_metadata,
            situacaoFlags: metadadosContrato ? metadadosContrato.situacaoFlags : [],
            situacao: metadadosContrato ? metadadosContrato.situacao : 'N/I',
            existencia: metadadosContrato ? 'AMBAS' : 'CONTÁBIL',
            data_inic: metadadosContrato ? metadadosContrato.data_inic : null,
            data_fim: metadadosContrato ? metadadosContrato.data_fim : null,
            dtInicVal: metadadosContrato ? metadadosContrato.dtInicVal : null,
            dtFimVal: metadadosContrato ? metadadosContrato.dtFimVal : null,
            dias_passaram: metadadosContrato ? metadadosContrato.dias_passaram : null,
            perc_tempo: metadadosContrato ? metadadosContrato.perc_tempo : null,
            encerrando_dias: metadadosContrato ? metadadosContrato.encerrando_dias : null,
            objeto: metadadosContrato ? metadadosContrato.objeto : '-',
            diasAss: null,
            v_empenhado: 0,
            v_recebido: 0,
            v_liquidado: 0,
            v_pago: 0,
            v_cancelado: 0,
            v_bloqueado: 0,
            has_empenhado: false,
            has_recebido: false,
            has_liquidado: false,
            has_pago: false,
            has_cancelado: false,
            has_bloqueado: false,
            movimentoFlags: [],
            movimentoStr: ""
          };
        }
        if (info.includes("EMPENHADO")) {
          grouped[key].v_empenhado += valor;
          grouped[key].has_empenhado = true;
        } else if (info.includes("RECEBIDO")) {
          grouped[key].v_recebido += valor;
          grouped[key].has_recebido = true;
        } else if (info.includes("LIQUIDADO")) {
          grouped[key].v_liquidado += valor;
          grouped[key].has_liquidado = true;
        } else if (info.includes("PAGO")) {
          grouped[key].v_pago += valor;
          grouped[key].has_pago = true;
        } else if (info.includes("CANCELADO")) {
          grouped[key].v_cancelado += valor;
          grouped[key].has_cancelado = true;
        } else if (info.includes("BLOQUEADO")) {
          grouped[key].v_bloqueado += valor;
          grouped[key].has_bloqueado = true;
        }
      }
      Object.keys(geralDict).forEach(contratoGeral => {
        if (!contratosEncontrados.has(contratoGeral)) {
          const meta = geralDict[contratoGeral];
          const metaOrcamentaria = orcamentarioDict[contratoGeral] || emptyOrcamentario();
          grouped[`DUMMY|${contratoGeral}`] = {
            dia: "-",
            diaVal: 0,
            ug: "-",
            favorecido: meta.fornecedor,
            empenho: "-",
            documento: "-",
            obs: "SEM LANÇAMENTOS CONTÁBEIS",
            contrato: meta.contrato,
            ...metaOrcamentaria,
            fiscal: meta.fiscal,
            gestor: meta.gestor,
            fiscal_sub: meta.fiscal_sub,
            gestor_sub: meta.gestor_sub,
            sec_log: meta.sec_log,
            modalidade: meta.modalidade,
            compra: meta.compra,
            objeto: meta.objeto,
            files: meta.files || ContractFiles.empty,
            contract_metadata: meta.contract_metadata,
            situacaoFlags: meta.situacaoFlags,
            situacao: meta.situacao,
            existencia: 'GERAL',
            data_inic: meta.data_inic,
            data_fim: meta.data_fim,
            dtInicVal: meta.dtInicVal,
            dtFimVal: meta.dtFimVal,
            dias_passaram: meta.dias_passaram,
            perc_tempo: meta.perc_tempo,
            encerrando_dias: meta.encerrando_dias,
            diasAss: null,
            v_empenhado: 0,
            v_recebido: 0,
            v_liquidado: 0,
            v_pago: 0,
            v_cancelado: 0,
            v_bloqueado: 0,
            has_empenhado: false,
            has_recebido: false,
            has_liquidado: false,
            has_pago: false,
            has_cancelado: false,
            has_bloqueado: false,
            movimentoFlags: [],
            movimentoStr: ""
          };
        }
      });
      Object.values(grouped).forEach(g => {
        if (g.existencia !== 'GERAL' && g.contrato !== '-' && g.empenho !== '-') {
          const minRo = minRoDict[`${UnifiedData.key(g.contrato)}|${UnifiedData.key(g.empenho)}`];
          if (minRo && g.dtInicVal) {
            g.diasAss = Math.floor((g.dtInicVal - minRo) / 86400000);
          } else {
            g.diasAss = null;
          }
        } else {
          g.diasAss = null;
        }
        let movStr = "";
        if (g.has_empenhado) {
          g.movimentoFlags.push({
            label: 'EMP',
            color: 'bg-blue-100 text-blue-800 border border-blue-200'
          });
          movStr += "EMP ";
        }
        if (g.has_recebido) {
          g.movimentoFlags.push({
            label: 'RCB',
            color: 'bg-violet-100 text-violet-800 border border-violet-200'
          });
          movStr += "RCB ";
        }
        if (g.has_liquidado) {
          g.movimentoFlags.push({
            label: 'LIQ',
            color: 'bg-amber-100 text-amber-800 border border-amber-200'
          });
          movStr += "LIQ ";
        }
        if (g.has_pago) {
          g.movimentoFlags.push({
            label: 'PAG',
            color: 'bg-emerald-100 text-emerald-800 border border-emerald-200'
          });
          movStr += "PAG ";
        }
        if (g.has_bloqueado) {
          g.movimentoFlags.push({
            label: 'BLOQ',
            color: 'bg-orange-100 text-orange-800 border border-orange-200'
          });
          movStr += "BLOQ ";
        }
        if (g.has_cancelado) {
          g.movimentoFlags.push({
            label: 'CAN',
            color: 'bg-red-100 text-red-800 border border-red-200'
          });
          movStr += "CAN ";
        }
        g.movimentoStr = movStr.trim();
      });
      setRawData(Object.values(grouped));
      setLoading(false);
    };
    useEffect(() => {
      if (payload) {
        processMergedData(payload.contabil || [], payload.geral || [], payload.orcamentario || []);
        setProcessedPayload(payload);
      }
    }, [payload, rawContracts]);
    const contractMap = useMemo(() => new Map(rawContracts.map(row => [UnifiedData.key(row.contrato), row])), [rawContracts]);
    const budgetIndex = useMemo(() => UnifiedData.budgetIndex(payload ? payload.orcamentario : []), [payload]);

    // Gera todas as listas dos filtros em uma única passagem e somente quando a carga muda.
    const filterOptions = useMemo(() => {
      const scalarFields = ['ug', 'favorecido', 'contrato', 'empenho', 'documento', 'modalidade', 'compra', 'gestor', 'fiscal', 'gestor_sub', 'fiscal_sub', 'sec_log', 'existencia'];
      const arrayFields = ['ao_codigo_values', 'ao_nome_values', 'po_codigo_values', 'po_nome_values', 'ptres_values', 'pi_cod_values', 'pi_nome_values', 'nd_codigo_values', 'nd_nome_values'];
      const sets = {};
      [...scalarFields, ...arrayFields].forEach(field => {
        sets[field] = new Set();
      });
      rawData.forEach(row => {
        scalarFields.forEach(field => {
          const value = row[field];
          if (value !== undefined && value !== null && value !== '') sets[field].add(value);
        });
        arrayFields.forEach(field => {
          (Array.isArray(row[field]) ? row[field] : []).forEach(value => {
            if (value !== undefined && value !== null && value !== '') sets[field].add(value);
          });
        });
      });
      const options = {};
      Object.keys(sets).forEach(field => {
        options[field] = [...sets[field]].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
      });
      return options;
    }, [rawData]);
    const filteredData = useMemo(() => {
      const selectedSets = {
        existencia: new Set(fExistencia),
        movimento: new Set(fMovimento),
        ug: new Set(fUg),
        favorecido: new Set(fFavorecido),
        empenho: new Set(fEmpenho),
        documento: new Set(fDocumento),
        contrato: new Set(fContrato),
        fiscal: new Set(fFiscal),
        gestor: new Set(fGestor),
        fiscal_sub: new Set(fFiscalSub),
        gestor_sub: new Set(fGestorSub),
        sec_log: new Set(fSecLog),
        compra: new Set(fCompra),
        modalidade: new Set(fModalidade),
        situacao: new Set(fSituacaoTags),
        ao_codigo: new Set(fAoCodigo),
        ao_nome: new Set(fAoNome),
        po_codigo: new Set(fPoCodigo),
        po_nome: new Set(fPoNome),
        ptres: new Set(fPtres),
        pi_cod: new Set(fPiCod),
        pi_nome: new Set(fPiNome),
        nd_codigo: new Set(fNdCodigo),
        nd_nome: new Set(fNdNome)
      };
      const matchesSelected = (set, value) => set.size === 0 || set.has(value);
      const matchesSelectedArray = (set, values) => set.size === 0 || Array.isArray(values) && values.some(value => set.has(value));
      const startOfDay = value => value ? new Date(value + "T00:00:00").getTime() : null;
      const endOfDay = value => value ? new Date(value + "T23:59:59").getTime() : null;
      const dateBounds = {
        diaDe: startOfDay(dDiaDe),
        diaAte: endOfDay(dDiaAte),
        inicDe: startOfDay(dInicDe),
        inicAte: endOfDay(dInicAte),
        fimDe: startOfDay(dFimDe),
        fimAte: endOfDay(dFimAte),
        colDiaMin: startOfDay(dateFilters.dia && dateFilters.dia.min),
        colDiaMax: endOfDay(dateFilters.dia && dateFilters.dia.max),
        colInicMin: startOfDay(dateFilters.data_inic && dateFilters.data_inic.min),
        colInicMax: endOfDay(dateFilters.data_inic && dateFilters.data_inic.max),
        colFimMin: startOfDay(dateFilters.data_fim && dateFilters.data_fim.min),
        colFimMax: endOfDay(dateFilters.data_fim && dateFilters.data_fim.max)
      };
      const searches = {
        contrato: searchContratoTabela.toUpperCase(),
        situacao: searchSituacaoTabela.toUpperCase(),
        existencia: searchExistenciaTabela.toUpperCase(),
        movimento: searchMovimentoTabela.toUpperCase(),
        emitente: searchEmitenteTabela.toUpperCase(),
        favorecido: searchUgNome.toUpperCase(),
        empenho: searchEmpenho.toUpperCase(),
        documento: searchDocumento.toUpperCase(),
        obs: searchObs.toUpperCase(),
        objeto: searchObjeto.toUpperCase(),
        gestor: searchGestorTabela.toUpperCase(),
        secLog: searchSecLogTabela.toUpperCase()
      };
      let filtered = rawData.filter(sourceItem => {
        const metadata = contractMap.get(UnifiedData.key(sourceItem.contrato));
        const item = metadata ? {
          ...sourceItem,
          situacaoFlags: metadata.situacaoFlags,
          situacao: metadata.situacao
        } : sourceItem;
        if (shared.fFornecedor.length && (!metadata || !shared.fFornecedor.includes(metadata.fornecedor))) return false;
        if (!UnifiedData.matchesBudgetRow(item, shared, budgetIndex)) return false;
        const matchExistencia = matchesSelected(selectedSets.existencia, item.existencia);
        const matchUg = matchesSelected(selectedSets.ug, item.ug);
        const matchFav = matchesSelected(selectedSets.favorecido, item.favorecido);
        const matchEmpenho = matchesSelected(selectedSets.empenho, item.empenho);
        const matchDoc = matchesSelected(selectedSets.documento, item.documento);
        const matchContrato = matchesSelected(selectedSets.contrato, item.contrato);
        const matchFiscal = matchesSelected(selectedSets.fiscal, item.fiscal);
        const matchGestor = matchesSelected(selectedSets.gestor, item.gestor);
        const matchFiscalSub = matchesSelected(selectedSets.fiscal_sub, item.fiscal_sub);
        const matchGestorSub = matchesSelected(selectedSets.gestor_sub, item.gestor_sub);
        const matchSecLog = matchesSelected(selectedSets.sec_log, item.sec_log);
        const matchCompra = matchesSelected(selectedSets.compra, item.compra);
        const matchModalidade = matchesSelected(selectedSets.modalidade, item.modalidade);
        const matchAoCodigo = matchesSelectedArray(selectedSets.ao_codigo, item.ao_codigo_values);
        const matchAoNome = matchesSelectedArray(selectedSets.ao_nome, item.ao_nome_values);
        const matchPoCodigo = matchesSelectedArray(selectedSets.po_codigo, item.po_codigo_values);
        const matchPoNome = matchesSelectedArray(selectedSets.po_nome, item.po_nome_values);
        const matchPtres = matchesSelectedArray(selectedSets.ptres, item.ptres_values);
        const matchPiCod = matchesSelectedArray(selectedSets.pi_cod, item.pi_cod_values);
        const matchPiNome = matchesSelectedArray(selectedSets.pi_nome, item.pi_nome_values);
        const matchNdCodigo = matchesSelectedArray(selectedSets.nd_codigo, item.nd_codigo_values);
        const matchNdNome = matchesSelectedArray(selectedSets.nd_nome, item.nd_nome_values);
        const matchDiaDe = dateBounds.diaDe === null || item.diaVal !== 0 && item.diaVal >= dateBounds.diaDe;
        const matchDiaAte = dateBounds.diaAte === null || item.diaVal !== 0 && item.diaVal <= dateBounds.diaAte;
        const matchInicDe = dateBounds.inicDe === null || item.dtInicVal && item.dtInicVal >= dateBounds.inicDe;
        const matchInicAte = dateBounds.inicAte === null || item.dtInicVal && item.dtInicVal <= dateBounds.inicAte;
        const matchFDe = dateBounds.fimDe === null || item.dtFimVal && item.dtFimVal >= dateBounds.fimDe;
        const matchFAte = dateBounds.fimAte === null || item.dtFimVal && item.dtFimVal <= dateBounds.fimAte;
        const matchSitTag = selectedSets.situacao.size === 0 || item.situacaoFlags && item.situacaoFlags.some(f => selectedSets.situacao.has(f.label));
        const matchMovimentoTag = selectedSets.movimento.size === 0 || selectedSets.movimento.has('EMP') && item.has_empenhado || selectedSets.movimento.has('RCB') && item.has_recebido || selectedSets.movimento.has('LIQ') && item.has_liquidado || selectedSets.movimento.has('PAG') && item.has_pago || selectedSets.movimento.has('BLOQ') && item.has_bloqueado || selectedSets.movimento.has('CAN') && item.has_cancelado;
        const searchContratoTabelaMatch = !searches.contrato || item.contrato.includes(searches.contrato) || item.compra.includes(searches.contrato) || item.modalidade.includes(searches.contrato);
        const searchSituacaoMatch = !searches.situacao || item.situacao.includes(searches.situacao);
        const searchExistenciaMatch = !searches.existencia || item.existencia.includes(searches.existencia);
        const searchMovimentoMatch = !searches.movimento || item.movimentoStr.includes(searches.movimento);
        const searchEmitenteMatch = !searches.emitente || item.ug.includes(searches.emitente);
        const searchUgNomeMatch = !searches.favorecido || item.favorecido.includes(searches.favorecido);
        const searchEmpenhoMatch = !searches.empenho || item.empenho.includes(searches.empenho);
        const searchDocumentoMatch = !searches.documento || item.documento.includes(searches.documento);
        const searchObsMatch = !searches.obs || item.obs.includes(searches.obs);
        const searchObjetoMatch = !searches.objeto || item.objeto.includes(searches.objeto);
        const searchGestorTMatch = !searches.gestor || item.gestor.includes(searches.gestor) || item.fiscal.includes(searches.gestor);
        const searchSecLogMatch = !searches.secLog || item.sec_log.includes(searches.secLog);
        let matchNum = true;
        for (const key in numFilters) {
          if (numFilters[key] && (numFilters[key].min !== '' || numFilters[key].max !== '')) {
            let val = item[key];
            if (val === null || val === undefined) {
              matchNum = false;
              break;
            }
            if (key.startsWith('p_')) val = val * 100;
            if (numFilters[key].min !== '' && val < parseFloat(numFilters[key].min)) {
              matchNum = false;
              break;
            }
            if (numFilters[key].max !== '' && val > parseFloat(numFilters[key].max)) {
              matchNum = false;
              break;
            }
          }
        }
        let matchDateCol = true;
        if (dateFilters.dia) {
          if (dateBounds.colDiaMin !== null && item.diaVal !== 0 && item.diaVal < dateBounds.colDiaMin) matchDateCol = false;
          if (dateBounds.colDiaMax !== null && item.diaVal !== 0 && item.diaVal > dateBounds.colDiaMax) matchDateCol = false;
        }
        if (dateFilters.data_inic) {
          if (dateBounds.colInicMin !== null && item.dtInicVal && item.dtInicVal < dateBounds.colInicMin) matchDateCol = false;
          if (dateBounds.colInicMax !== null && item.dtInicVal && item.dtInicVal > dateBounds.colInicMax) matchDateCol = false;
        }
        if (dateFilters.data_fim) {
          if (dateBounds.colFimMin !== null && item.dtFimVal && item.dtFimVal < dateBounds.colFimMin) matchDateCol = false;
          if (dateBounds.colFimMax !== null && item.dtFimVal && item.dtFimVal > dateBounds.colFimMax) matchDateCol = false;
        }
        const matchBloqueado = !fOnlyBloqueado || item.has_bloqueado;
        const matchCancelado = !fOnlyCancelado || item.has_cancelado;
        return matchExistencia && matchUg && matchFav && matchEmpenho && matchDoc && matchContrato && matchMovimentoTag && matchFiscal && matchGestor && matchFiscalSub && matchGestorSub && matchSecLog && matchCompra && matchModalidade && matchAoCodigo && matchAoNome && matchPoCodigo && matchPoNome && matchPtres && matchPiCod && matchPiNome && matchNdCodigo && matchNdNome && matchDiaDe && matchDiaAte && matchInicDe && matchInicAte && matchFDe && matchFAte && matchSitTag && searchContratoTabelaMatch && searchSituacaoMatch && searchExistenciaMatch && searchMovimentoMatch && searchEmitenteMatch && searchUgNomeMatch && searchEmpenhoMatch && searchDocumentoMatch && searchObsMatch && searchObjetoMatch && searchGestorTMatch && searchSecLogMatch && matchNum && matchDateCol && matchBloqueado && matchCancelado;
      });
      if (sortConfig.key) {
        filtered.sort((a, b) => {
          let valA = a[sortConfig.key],
            valB = b[sortConfig.key];
          if (sortConfig.key === 'data_inic') {
            valA = a.dtInicVal;
            valB = b.dtInicVal;
          } else if (sortConfig.key === 'data_fim') {
            valA = a.dtFimVal;
            valB = b.dtFimVal;
          }
          if (valA === null) valA = -Number.MAX_VALUE;
          if (valB === null) valB = -Number.MAX_VALUE;
          if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
          if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
          return 0;
        });
      }
      return filtered;
    }, [rawData, shared, contractMap, budgetIndex, fExistencia, fMovimento, fUg, fFavorecido, fEmpenho, fDocumento, fContrato, fFiscal, fGestor, fFiscalSub, fGestorSub, fSecLog, fCompra, fModalidade, fAoCodigo, fAoNome, fPoCodigo, fPoNome, fPtres, fPiCod, fPiNome, fNdCodigo, fNdNome, dDiaDe, dDiaAte, dInicDe, dInicAte, dFimDe, dFimAte, fSituacaoTags, searchContratoTabela, searchSituacaoTabela, searchExistenciaTabela, searchMovimentoTabela, searchEmitenteTabela, searchUgNome, searchEmpenho, searchDocumento, searchObs, searchObjeto, searchGestorTabela, searchSecLogTabela, numFilters, dateFilters, fOnlyBloqueado, fOnlyCancelado, sortConfig]);
    const totalsMaster = useMemo(() => {
      let emp = 0,
        rec = 0,
        liq = 0,
        pag = 0,
        can = 0,
        blo = 0;
      filteredData.forEach(r => {
        emp += r.v_empenhado;
        rec += r.v_recebido;
        liq += r.v_liquidado;
        pag += r.v_pago;
        can += r.v_cancelado;
        blo += r.v_bloqueado;
      });
      return {
        emp,
        rec,
        liq,
        pag,
        can,
        blo
      };
    }, [filteredData]);
    const countSoGeral = useMemo(() => {
      const unique = new Set();
      filteredData.forEach(d => {
        if (d.existencia === 'GERAL' && d.contrato !== '-') unique.add(d.contrato);
      });
      return unique.size;
    }, [filteredData]);
    const countSoContabil = useMemo(() => {
      const unique = new Set();
      filteredData.forEach(d => {
        if (d.existencia === 'CONTÁBIL' && d.contrato !== '-') unique.add(d.contrato);
      });
      return unique.size;
    }, [filteredData]);
    const docCounts = useMemo(() => {
      const uniqueDocs = field => new Set(filteredData.filter(d => d[field.replace('v_', 'has_')]).map(UnifiedData.documentId)).size;
      return {
        empenhado: uniqueDocs('v_empenhado'),
        recebido: uniqueDocs('v_recebido'),
        liquidado: uniqueDocs('v_liquidado'),
        pago: uniqueDocs('v_pago')
      };
    }, [filteredData]);
    const totalUniqueDocs = useMemo(() => new Set(filteredData.filter(d => d.documento && d.documento !== "-").map(UnifiedData.documentId)).size, [filteredData]);
    const docStats = useMemo(() => {
      const stats = {
        rone: {
          latestDate: null,
          latestVal: 0,
          set: new Set()
        },
        nsnl_rec: {
          latestDate: null,
          latestVal: 0,
          set: new Set()
        },
        nsnl_liq: {
          latestDate: null,
          latestVal: 0,
          set: new Set()
        },
        ob: {
          latestDate: null,
          latestVal: 0,
          set: new Set()
        },
        df: {
          latestDate: null,
          latestVal: 0,
          set: new Set()
        }
      };
      filteredData.forEach(item => {
        if (!item.documento || item.documento === "-") return;
        const doc = item.documento.toUpperCase();
        const updateStat = target => {
          target.set.add(UnifiedData.documentId(item));
          if (!target.latestVal || item.diaVal > target.latestVal) {
            target.latestVal = item.diaVal;
            target.latestDate = item.dia;
          }
        };
        if (doc.includes('RO') || doc.includes('NE')) updateStat(stats.rone);
        if (doc.includes('NS') || doc.includes('NL')) {
          if (item.has_recebido) updateStat(stats.nsnl_rec);
          if (item.has_liquidado) updateStat(stats.nsnl_liq);
        }
        if (doc.includes('OB')) updateStat(stats.ob);
        if (doc.includes('DF')) updateStat(stats.df);
      });
      return {
        rone: {
          count: stats.rone.set.size,
          latestDate: stats.rone.latestDate,
          latestVal: stats.rone.latestVal
        },
        nsnl_rec: {
          count: stats.nsnl_rec.set.size,
          latestDate: stats.nsnl_rec.latestDate,
          latestVal: stats.nsnl_rec.latestVal
        },
        nsnl_liq: {
          count: stats.nsnl_liq.set.size,
          latestDate: stats.nsnl_liq.latestDate,
          latestVal: stats.nsnl_liq.latestVal
        },
        ob: {
          count: stats.ob.set.size,
          latestDate: stats.ob.latestDate,
          latestVal: stats.ob.latestVal
        },
        df: {
          count: stats.df.set.size,
          latestDate: stats.df.latestDate,
          latestVal: stats.df.latestVal
        }
      };
    }, [filteredData]);
    const kpis = useMemo(() => {
      const uniqueContratos = new Set();
      const gestoresTitulares = new Set();
      const gestoresSubstitutos = new Set();
      const fiscaisTitulares = new Set();
      const fiscaisSubstitutos = new Set();
      const addPessoaValida = (set, value) => {
        const val = (value || '').toString().trim();
        if (val && val !== '-' && val !== 'N/I') set.add(val);
      };
      let qtdAtivos = 0,
        qtdAtivosInexec = 0,
        qtdAtivosEmExec = 0,
        qtdAtivosExecTot = 0,
        qtdAtivosExecParc = 0;
      let qtdVencidos = 0,
        qtdVencInexecTot = 0,
        qtdVencidosTot = 0,
        qtdVencidosParc = 0;
      let qtdBloqueados = 0,
        qtdCancelados = 0;
      let totalGlobal = 0;
      filteredData.forEach(item => {
        addPessoaValida(gestoresTitulares, item.gestor);
        addPessoaValida(gestoresSubstitutos, item.gestor_sub);
        addPessoaValida(fiscaisTitulares, item.fiscal);
        addPessoaValida(fiscaisSubstitutos, item.fiscal_sub);
        if (item.contrato && item.contrato.trim() !== "" && item.contrato !== "-") {
          if (!uniqueContratos.has(UnifiedData.key(item.contrato))) {
            uniqueContratos.add(UnifiedData.key(item.contrato));
            if (item.situacaoFlags && item.situacaoFlags.some(f => f.label === 'CAN')) qtdCancelados++;
            if (item.situacaoFlags && item.situacaoFlags.some(f => f.label === 'BLOQ')) qtdBloqueados++;
            totalGlobal += item.v_global || 0;
            if (ContractRules.phase(item) === 'vigente') {
              qtdAtivos++;
              if (item.situacaoFlags.some(f => f.label === 'VIG SEM EXEC')) qtdAtivosInexec++;
              if (item.situacaoFlags.some(f => f.label === 'VIG EM EXEC')) qtdAtivosEmExec++;
              if (item.situacaoFlags.some(f => f.label === 'VIG EXEC TOTAL')) qtdAtivosExecTot++;
              if (item.situacaoFlags.some(f => f.label === 'VIG EXEC PARCIAL')) qtdAtivosExecParc++;
            } else if (ContractRules.phase(item) === 'vencido') {
              qtdVencidos++;
              if (item.situacaoFlags.some(f => f.label === 'VENC INEXEC TOTAL')) qtdVencInexecTot++;
              if (item.situacaoFlags.some(f => f.label === 'VENC EXEC TOTAL')) qtdVencidosTot++;
              if (item.situacaoFlags.some(f => f.label === 'VENC EXEC PARCIAL')) qtdVencidosParc++;
            }
          }
        }
      });
      return {
        qtdContratos: uniqueContratos.size,
        qtdGestoresTitulares: gestoresTitulares.size,
        qtdGestoresSubstitutos: gestoresSubstitutos.size,
        qtdGestores: gestoresTitulares.size + gestoresSubstitutos.size,
        qtdFiscaisTitulares: fiscaisTitulares.size,
        qtdFiscaisSubstitutos: fiscaisSubstitutos.size,
        qtdFiscais: fiscaisTitulares.size + fiscaisSubstitutos.size,
        qtdFornecedores: new Set(filteredData.map(d => d.favorecido).filter(v => v && v !== '-' && v !== 'N/I')).size,
        qtdAtivos,
        qtdAtivosInexec,
        qtdAtivosEmExec,
        qtdAtivosExecTot,
        qtdAtivosExecParc,
        qtdVencidos,
        qtdVencInexecTot,
        qtdVencidosTot,
        qtdVencidosParc,
        qtdBloqueados,
        qtdCancelados,
        totalGlobal,
        totalEmpenhado: totalsMaster.emp,
        totalRecebido: totalsMaster.rec,
        percRecebido: totalsMaster.emp ? totalsMaster.rec / totalsMaster.emp : 0,
        totalLiquidado: totalsMaster.liq,
        percLiquidado: totalsMaster.emp ? totalsMaster.liq / totalsMaster.emp : 0,
        totalPago: totalsMaster.pag,
        percPago: totalsMaster.emp ? totalsMaster.pag / totalsMaster.emp : 0,
        totalCancelado: totalsMaster.can,
        percCancelado: totalsMaster.emp ? totalsMaster.can / totalsMaster.emp : 0,
        totalBloqueado: totalsMaster.blo,
        percBloqueado: totalsMaster.emp ? totalsMaster.blo / totalsMaster.emp : 0,
        percEmpenhadoDoGlobal: totalGlobal ? totalsMaster.emp / totalGlobal : 0
      };
    }, [filteredData, totalsMaster]);
    const contratoAnoOrigem = useMemo(() => {
      const map = {};
      filteredData.forEach(item => {
        if (!item.diaVal || !item.contrato || item.contrato === "-") return;
        const doc = item.documento ? item.documento.toUpperCase() : "";
        if (doc.includes("NE") || doc.includes("RO")) {
          if (!map[UnifiedData.key(item.contrato)] || item.diaVal < map[UnifiedData.key(item.contrato)].minDate) {
            map[UnifiedData.key(item.contrato)] = {
              minDate: item.diaVal,
              ano: new Date(item.diaVal).getFullYear()
            };
          }
        }
      });
      return map;
    }, [filteredData]);
    const processTop20Data = (viewMode, sortMode) => {
      const map = {};
      filteredData.forEach(item => {
        if (!item.contrato || item.contrato === "-") return;
        let key = '';
        if (viewMode === 'contrato') key = UnifiedData.key(item.contrato);else if (viewMode === 'favorecido') key = item.favorecido;else if (viewMode === 'empenho') key = item.empenho;else if (viewMode === 'ano') {
          const origem = contratoAnoOrigem[UnifiedData.key(item.contrato)];
          key = origem ? origem.ano.toString() : 'N/I';
        } else if (viewMode === 'sec_log') key = item.sec_log;
        if (!map[key]) {
          map[key] = {
            label: viewMode === 'contrato' ? item.contrato : key,
            contratos: new Set(),
            empenhado: 0,
            recebido: 0,
            liquidado: 0,
            pago: 0,
            bloqueado: 0,
            cancelado: 0,
            favorecido: item.favorecido,
            contrato: item.contrato
          };
        }
        map[key].contratos.add(UnifiedData.key(item.contrato));
        map[key].empenhado += item.v_empenhado;
        map[key].recebido += item.v_recebido;
        map[key].liquidado += item.v_liquidado;
        map[key].pago += item.v_pago;
        map[key].bloqueado += item.v_bloqueado;
        map[key].cancelado += item.v_cancelado;
      });
      let arr = Object.values(map).map(d => ({
        ...d,
        count: d.contratos.size
      }));
      if (sortMode === 'emp_desc') arr.sort((a, b) => b.empenhado - a.empenhado);else if (sortMode === 'rec_desc') arr.sort((a, b) => b.recebido - a.recebido);else if (sortMode === 'liq_desc') arr.sort((a, b) => b.liquidado - a.liquidado);else if (sortMode === 'pag_desc') arr.sort((a, b) => b.pago - a.pago);else if (sortMode === 'can_desc') arr.sort((a, b) => b.cancelado - a.cancelado);else if (sortMode === 'bloq_desc') arr.sort((a, b) => b.bloqueado - a.bloqueado);else if (sortMode === 'qtd_desc') arr.sort((a, b) => b.count - a.count);else if (sortMode === 'aliq_desc') arr.sort((a, b) => b.empenhado - b.liquidado - b.bloqueado - b.cancelado - (a.empenhado - a.liquidado - a.bloqueado - a.cancelado));else if (sortMode === 'apag_desc') arr.sort((a, b) => b.empenhado - b.pago - b.bloqueado - b.cancelado - (a.empenhado - a.pago - a.bloqueado - a.cancelado));else if (sortMode === 'nome_asc') arr.sort((a, b) => a.label.localeCompare(b.label));else arr.sort((a, b) => b.empenhado - a.empenhado);
      return arr.slice(0, 20);
    };
    const top20DataProcessed = useMemo(() => processTop20Data(top20ViewMode, top20Sort), [filteredData, top20ViewMode, top20Sort, contratoAnoOrigem]);
    const top20100DataProcessed = useMemo(() => processTop20Data(top20100ViewMode, top20100Sort), [filteredData, top20100ViewMode, top20100Sort, contratoAnoOrigem]);
    const calculateAggregatedData = function (aggLevel) {
      let normalizeXAxis = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;
      const sortedData = [...filteredData].sort((a, b) => a.diaVal - b.diaVal);
      const buckets = {};
      const keys = [];
      let max_val = 1;
      sortedData.forEach(item => {
        if (!item.diaVal) return;
        const d = new Date(item.diaVal);
        let key = '',
          label = '';
        if (aggLevel === 'dia') {
          key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          label = item.dia;
        } else if (aggLevel === 'mes') {
          key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          label = `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
        } else {
          key = `${d.getFullYear()}`;
          label = `${d.getFullYear()}`;
        }
        if (!buckets[key]) {
          buckets[key] = {
            label,
            inc_emp: 0,
            inc_rec: 0,
            inc_liq: 0,
            inc_pag: 0,
            inc_can: 0,
            inc_blo: 0,
            docs_emp: [],
            docs_rec: [],
            docs_liq: [],
            docs_pag: [],
            docs_can: [],
            docs_blo: []
          };
          keys.push(key);
        }
        buckets[key].inc_emp += item.v_empenhado;
        buckets[key].inc_rec += item.v_recebido;
        buckets[key].inc_liq += item.v_liquidado;
        buckets[key].inc_pag += item.v_pago;
        buckets[key].inc_can += item.v_cancelado;
        buckets[key].inc_blo += item.v_bloqueado;
        if (item.v_empenhado !== 0 && buckets[key].docs_emp.length < 15) buckets[key].docs_emp.push(`C: ${item.contrato} | Doc: ${item.documento} (${formatBRL(item.v_empenhado)})`);
        if (item.v_recebido !== 0 && buckets[key].docs_rec.length < 15) buckets[key].docs_rec.push(`C: ${item.contrato} | Doc: ${item.documento} (${formatBRL(item.v_recebido)})`);
        if (item.v_liquidado !== 0 && buckets[key].docs_liq.length < 15) buckets[key].docs_liq.push(`C: ${item.contrato} | Doc: ${item.documento} (${formatBRL(item.v_liquidado)})`);
        if (item.v_pago !== 0 && buckets[key].docs_pag.length < 15) buckets[key].docs_pag.push(`C: ${item.contrato} | Doc: ${item.documento} (${formatBRL(item.v_pago)})`);
        if (item.v_cancelado !== 0 && buckets[key].docs_can.length < 15) buckets[key].docs_can.push(`C: ${item.contrato} | Doc: ${item.documento} (${formatBRL(item.v_cancelado)})`);
        if (item.v_bloqueado !== 0 && buckets[key].docs_blo.length < 15) buckets[key].docs_blo.push(`C: ${item.contrato} | Doc: ${item.documento} (${formatBRL(item.v_bloqueado)})`);
      });
      if (normalizeXAxis) {
        const validRows = sortedData.filter(item => item.diaVal);
        if (validRows.length > 0) {
          const min = new Date(validRows[0].diaVal);
          const max = new Date(validRows[validRows.length - 1].diaVal);
          min.setHours(0, 0, 0, 0);
          max.setHours(0, 0, 0, 0);
          const normalizedKeys = [];
          if (aggLevel === 'dia') {
            const cur = new Date(min);
            while (cur <= max) {
              const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
              const label = `${String(cur.getDate()).padStart(2, '0')}/${String(cur.getMonth() + 1).padStart(2, '0')}/${cur.getFullYear()}`;
              if (!buckets[key]) buckets[key] = {
                label,
                inc_emp: 0,
                inc_rec: 0,
                inc_liq: 0,
                inc_pag: 0,
                inc_can: 0,
                inc_blo: 0,
                docs_emp: [],
                docs_rec: [],
                docs_liq: [],
                docs_pag: [],
                docs_can: [],
                docs_blo: []
              };
              normalizedKeys.push(key);
              cur.setDate(cur.getDate() + 1);
            }
          } else if (aggLevel === 'mes') {
            const cur = new Date(min.getFullYear(), min.getMonth(), 1);
            const end = new Date(max.getFullYear(), max.getMonth(), 1);
            while (cur <= end) {
              const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
              const label = `${String(cur.getMonth() + 1).padStart(2, '0')}/${cur.getFullYear()}`;
              if (!buckets[key]) buckets[key] = {
                label,
                inc_emp: 0,
                inc_rec: 0,
                inc_liq: 0,
                inc_pag: 0,
                inc_can: 0,
                inc_blo: 0,
                docs_emp: [],
                docs_rec: [],
                docs_liq: [],
                docs_pag: [],
                docs_can: [],
                docs_blo: []
              };
              normalizedKeys.push(key);
              cur.setMonth(cur.getMonth() + 1);
            }
          } else {
            for (let y = min.getFullYear(); y <= max.getFullYear(); y++) {
              const key = `${y}`;
              if (!buckets[key]) buckets[key] = {
                label: key,
                inc_emp: 0,
                inc_rec: 0,
                inc_liq: 0,
                inc_pag: 0,
                inc_can: 0,
                inc_blo: 0,
                docs_emp: [],
                docs_rec: [],
                docs_liq: [],
                docs_pag: [],
                docs_can: [],
                docs_blo: []
              };
              normalizedKeys.push(key);
            }
          }
          keys.length = 0;
          keys.push(...normalizedKeys);
        }
      }
      const labels = [],
        d_emp = [],
        d_rec = [],
        d_liq = [],
        d_pag = [],
        d_can = [],
        d_blo = [];
      const tooltips = [[], [], [], [], [], []];
      keys.forEach(k => {
        const b = buckets[k];
        labels.push(b.label);
        d_emp.push(b.inc_emp);
        d_rec.push(b.inc_rec);
        d_liq.push(b.inc_liq);
        d_pag.push(b.inc_pag);
        d_can.push(b.inc_can);
        d_blo.push(b.inc_blo);
        tooltips[0].push(b.docs_emp);
        tooltips[1].push(b.docs_rec);
        tooltips[2].push(b.docs_liq);
        tooltips[3].push(b.docs_pag);
        tooltips[4].push(b.docs_can);
        tooltips[5].push(b.docs_blo);
        const localMax = Math.max(b.inc_emp, b.inc_rec, b.inc_liq, b.inc_pag, b.inc_can, b.inc_blo);
        if (localMax > max_val) max_val = localMax;
      });
      return {
        labels,
        d_emp,
        d_rec,
        d_liq,
        d_pag,
        d_can,
        d_blo,
        tooltips,
        max_val,
        keys,
        buckets
      };
    };
    const areaChartData = useMemo(() => {
      const agg = calculateAggregatedData(areaAggLevel, areaXAxisMode === 'normalizada');
      let cum_emp = 0,
        cum_rec = 0,
        cum_liq = 0,
        cum_pag = 0,
        cum_can = 0,
        cum_blo = 0;
      const d_emp_cum = [],
        d_rec_cum = [],
        d_liq_cum = [],
        d_pag_cum = [],
        d_can_cum = [],
        d_blo_cum = [],
        d_aliq_cum = [],
        d_apag_cum = [];
      agg.keys.forEach(k => {
        const b = agg.buckets[k];
        cum_emp += b.inc_emp;
        cum_rec += b.inc_rec;
        cum_liq += b.inc_liq;
        cum_pag += b.inc_pag;
        cum_can += b.inc_can;
        cum_blo += b.inc_blo;
        d_emp_cum.push(cum_emp);
        d_rec_cum.push(cum_rec);
        d_liq_cum.push(cum_liq);
        d_pag_cum.push(cum_pag);
        d_can_cum.push(cum_can);
        d_blo_cum.push(cum_blo);
        d_aliq_cum.push(Math.max(0, cum_emp - cum_liq - cum_blo - cum_can));
        d_apag_cum.push(Math.max(0, cum_emp - cum_pag - cum_blo - cum_can));
      });
      return {
        labels: agg.labels,
        d_emp: d_emp_cum,
        d_rec: d_rec_cum,
        d_liq: d_liq_cum,
        d_pag: d_pag_cum,
        d_can: d_can_cum,
        d_blo: d_blo_cum,
        d_aliq: d_aliq_cum,
        d_apag: d_apag_cum,
        tooltips: agg.tooltips
      };
    }, [filteredData, areaAggLevel, areaXAxisMode]);
    const barChartData = useMemo(() => calculateAggregatedData(barAggLevel, barXAxisMode === 'normalizada'), [filteredData, barAggLevel, barXAxisMode]);
    const documentDateRange = useMemo(() => {
      var _first, _first2, _last, _last2;
      let first = null,
        last = null;
      filteredData.forEach(row => {
        if (!row.documento || row.documento === '-' || !Number.isFinite(row.diaVal) || row.diaVal <= 0) return;
        if (!first || row.diaVal < first.diaVal) first = row;
        if (!last || row.diaVal > last.diaVal) last = row;
      });
      return {
        firstDate: ((_first = first) === null || _first === void 0 ? void 0 : _first.dia) || '',
        firstValue: ((_first2 = first) === null || _first2 === void 0 ? void 0 : _first2.diaVal) || null,
        lastDate: ((_last = last) === null || _last === void 0 ? void 0 : _last.dia) || '',
        lastValue: ((_last2 = last) === null || _last2 === void 0 ? void 0 : _last2.diaVal) || null
      };
    }, [filteredData]);
    const latestDocs = useMemo(() => {
      const getLatestList = field => {
        const hasField = field.replace('v_', 'has_');
        const validDocs = filteredData.filter(d => d[hasField] && d.diaVal !== 0);
        if (validDocs.length === 0) return [];
        const maxVal = Math.max(...validDocs.map(d => d.diaVal));
        return validDocs.filter(d => d.diaVal === maxVal).sort((a, b) => b[field] - a[field]).slice(0, 10);
      };
      return {
        empenhado: getLatestList('v_empenhado'),
        recebido: getLatestList('v_recebido'),
        liquidado: getLatestList('v_liquidado'),
        pago: getLatestList('v_pago')
      };
    }, [filteredData]);
    const primeirosDocs = useMemo(() => {
      const getFirstList = field => {
        const hasField = field.replace('v_', 'has_');
        const validDocs = filteredData.filter(d => d[hasField] && d.diaVal !== 0);
        if (validDocs.length === 0) return [];
        const minVal = Math.min(...validDocs.map(d => d.diaVal));
        return validDocs.filter(d => d.diaVal === minVal).sort((a, b) => b[field] - a[field]).slice(0, 10);
      };
      return {
        empenhado: getFirstList('v_empenhado'),
        recebido: getFirstList('v_recebido'),
        liquidado: getFirstList('v_liquidado'),
        pago: getFirstList('v_pago')
      };
    }, [filteredData]);
    const matrixAggregatedData = useMemo(() => {
      const map = new Map();
      const getMatrixGroupMeta = item => {
        const secLog = item.sec_log || "N/I";
        const contrato = item.contrato || "-";
        const empenho = item.empenho || "-";
        const favorecido = item.favorecido || "N/I";
        const objeto = item.objeto || "-";
        // Mantém uma única classificação por lançamento. Se a origem trouxer
        // mais de uma ND para o mesmo Documento CCor, exibe a combinação sem
        // duplicar os valores financeiros da linha.
        const ndCodigo = [...new Set((item.nd_codigo_values || []).filter(Boolean))].sort().join(' / ') || "N/I";
        if (matrixGroupBy === 'contrato') {
          return {
            key: JSON.stringify([contrato]),
            sec_log: secLog,
            contrato,
            compra: item.compra,
            modalidade: item.modalidade,
            empenho: "VÁRIOS",
            favorecido: "VÁRIOS",
            objeto: "VÁRIOS",
            nd_codigo: "VÁRIAS"
          };
        }
        if (matrixGroupBy === 'empenho') {
          return {
            key: JSON.stringify([empenho]),
            sec_log: secLog,
            contrato: "VÁRIOS",
            compra: "-",
            modalidade: "-",
            empenho,
            favorecido: "VÁRIOS",
            objeto: "VÁRIOS",
            nd_codigo: "VÁRIAS"
          };
        }
        if (matrixGroupBy === 'sec_log') {
          return {
            key: JSON.stringify([secLog]),
            sec_log: secLog,
            contrato: "VÁRIOS",
            compra: "-",
            modalidade: "-",
            empenho: "VÁRIOS",
            favorecido: "VÁRIOS",
            objeto: "VÁRIOS",
            nd_codigo: "VÁRIAS"
          };
        }
        if (matrixGroupBy === 'contrato_favorecido') {
          return {
            key: JSON.stringify([UnifiedData.key(contrato), favorecido]),
            sec_log: secLog,
            contrato,
            compra: item.compra,
            modalidade: item.modalidade,
            empenho: "VÁRIOS",
            favorecido,
            objeto: "VÁRIOS",
            nd_codigo: "VÁRIAS"
          };
        }
        if (matrixGroupBy === 'contrato_favorecido_objeto') {
          return {
            key: JSON.stringify([UnifiedData.key(contrato), favorecido, objeto]),
            sec_log: secLog,
            contrato,
            compra: item.compra,
            modalidade: item.modalidade,
            empenho: "VÁRIOS",
            favorecido,
            objeto,
            nd_codigo: "VÁRIAS"
          };
        }
        if (matrixGroupBy === 'contrato_nd') {
          return {
            key: JSON.stringify([UnifiedData.key(contrato), ndCodigo]),
            sec_log: secLog,
            contrato,
            compra: item.compra,
            modalidade: item.modalidade,
            empenho: "VÁRIOS",
            favorecido: "VÁRIOS",
            objeto: "VÁRIOS",
            nd_codigo: ndCodigo
          };
        }
        if (matrixGroupBy === 'sec_log_contrato_empenho') {
          return {
            key: JSON.stringify([secLog, UnifiedData.key(contrato), empenho]),
            sec_log: secLog,
            contrato,
            compra: item.compra,
            modalidade: item.modalidade,
            empenho,
            favorecido: "VÁRIOS",
            objeto: "VÁRIOS",
            nd_codigo: "VÁRIAS"
          };
        }
        return {
          key: JSON.stringify([UnifiedData.key(contrato), empenho]),
          sec_log: secLog,
          contrato,
          compra: item.compra,
          modalidade: item.modalidade,
          empenho,
          favorecido: "VÁRIOS",
          objeto: "VÁRIOS",
          nd_codigo: "VÁRIAS"
        };
      };
      filteredData.forEach(item => {
        if (!item.contrato || item.contrato === "-") return;
        const meta = getMatrixGroupMeta(item);
        const key = meta.key;
        if (!map.has(key)) {
          map.set(key, {
            groupKey: key,
            sec_log: meta.sec_log,
            contrato: meta.contrato,
            compra: meta.compra,
            modalidade: meta.modalidade,
            empenho: meta.empenho,
            portal_contexts: new Map(),
            favorecido: meta.favorecido,
            objeto: meta.objeto,
            nd_codigo: meta.nd_codigo,
            dtInicVal: item.dtInicVal,
            min_ro_val: Infinity,
            docs_emp: new Set(),
            docs_rec: new Set(),
            docs_liq: new Set(),
            docs_pag: new Set(),
            docs_bloq: new Set(),
            docs_can: new Set(),
            v_emp: 0,
            v_rec: 0,
            v_liq: 0,
            v_pag: 0,
            v_bloq: 0,
            v_can: 0
          });
        }
        const m = map.get(key);
        const matrixContexts = Object.prototype.hasOwnProperty.call(item, "portal_contexts") ? Array.isArray(item.portal_contexts) && item.portal_contexts.length ? item.portal_contexts : [{}] : [{
          ug: item.portal_ug ?? item.ug,
          gestao: item.gestao
        }];
        matrixContexts.forEach(context => m.portal_contexts.set(JSON.stringify(context), {
          ...context
        }));
        if (item.dtInicVal && (!m.dtInicVal || item.dtInicVal < m.dtInicVal)) {
          m.dtInicVal = item.dtInicVal;
        }
        if (item.documento.includes("RO") && item.diaVal > 0) {
          if (item.diaVal < m.min_ro_val) m.min_ro_val = item.diaVal;
        }
        if (item.has_empenhado) m.docs_emp.add(UnifiedData.documentId(item));
        if (item.has_recebido) m.docs_rec.add(UnifiedData.documentId(item));
        if (item.has_liquidado) m.docs_liq.add(UnifiedData.documentId(item));
        if (item.has_pago) m.docs_pag.add(UnifiedData.documentId(item));
        if (item.has_bloqueado) m.docs_bloq.add(UnifiedData.documentId(item));
        if (item.has_cancelado) m.docs_can.add(UnifiedData.documentId(item));
        m.v_emp += item.v_empenhado;
        m.v_rec += item.v_recebido;
        m.v_liq += item.v_liquidado;
        m.v_pag += item.v_pago;
        m.v_bloq += item.v_bloqueado;
        m.v_can += item.v_cancelado;
      });
      return [...map.values()].map(m => {
        let diasAss = null;
        if (matrixGroupBy !== 'sec_log' && m.min_ro_val !== Infinity && m.dtInicVal) {
          diasAss = Math.floor((m.dtInicVal - m.min_ro_val) / 86400000);
        }
        let v_saldo_exec = m.v_emp - m.v_liq - m.v_can - m.v_bloq;
        return {
          groupKey: m.groupKey,
          sec_log: m.sec_log,
          contrato: m.contrato,
          compra: m.compra,
          modalidade: m.modalidade,
          empenho: m.empenho,
          portal_contexts: [...m.portal_contexts.values()],
          favorecido: m.favorecido,
          objeto: m.objeto,
          nd_codigo: m.nd_codigo,
          diasAss: diasAss,
          qtd_emp: m.docs_emp.size,
          qtd_rec: m.docs_rec.size,
          qtd_liq: m.docs_liq.size,
          qtd_pag: m.docs_pag.size,
          qtd_bloq: m.docs_bloq.size,
          qtd_can: m.docs_can.size,
          v_emp: m.v_emp,
          v_rec: m.v_rec,
          v_liq: m.v_liq,
          v_pag: m.v_pag,
          v_bloq: m.v_bloq,
          v_can: m.v_can,
          v_saldo_exec: v_saldo_exec,
          sortVal: m.min_ro_val !== Infinity ? m.min_ro_val : Number.MAX_SAFE_INTEGER
        };
      });
    }, [filteredData, matrixGroupBy]);

    // Ordenar não refaz a agregação nem os conjuntos de documentos.
    const matrixData = useMemo(() => {
      const arr = [...matrixAggregatedData];
      arr.sort((a, b) => {
        let valA = a[matrixSort.key],
          valB = b[matrixSort.key];
        if (matrixSort.key === 'diasAss') {
          valA = valA !== null ? valA : matrixSort.direction === 'asc' ? Infinity : -Infinity;
          valB = valB !== null ? valB : matrixSort.direction === 'asc' ? Infinity : -Infinity;
        }
        if (valA < valB) return matrixSort.direction === 'asc' ? -1 : 1;
        if (valA > valB) return matrixSort.direction === 'asc' ? 1 : -1;
        return 0;
      });
      return arr;
    }, [matrixAggregatedData, matrixSort]);
    const matrixTotals = useMemo(() => {
      let sumQtdEmp = 0,
        sumQtdRec = 0,
        sumQtdLiq = 0,
        sumQtdPag = 0,
        sumQtdBloq = 0,
        sumQtdCan = 0;
      let sumVEmp = 0,
        sumVRec = 0,
        sumVLiq = 0,
        sumVPag = 0,
        sumVBloq = 0,
        sumVCan = 0,
        sumVSaldoExec = 0;
      let sumDias = 0,
        countDias = 0;
      matrixAggregatedData.forEach(row => {
        sumQtdEmp += row.qtd_emp;
        sumQtdRec += row.qtd_rec;
        sumQtdLiq += row.qtd_liq;
        sumQtdPag += row.qtd_pag;
        sumQtdBloq += row.qtd_bloq;
        sumQtdCan += row.qtd_can;
        sumVEmp += row.v_emp;
        sumVRec += row.v_rec;
        sumVLiq += row.v_liq;
        sumVPag += row.v_pag;
        sumVBloq += row.v_bloq;
        sumVCan += row.v_can;
        sumVSaldoExec += row.v_saldo_exec;
        if (row.diasAss !== null && row.diasAss >= 0) {
          sumDias += row.diasAss;
          countDias++;
        }
      });
      const mediaDias = countDias > 0 ? (sumDias / countDias).toFixed(1) : '-';
      return {
        sumQtdEmp,
        sumQtdRec,
        sumQtdLiq,
        sumQtdPag,
        sumQtdBloq,
        sumQtdCan,
        sumVEmp,
        sumVRec,
        sumVLiq,
        sumVPag,
        sumVBloq,
        sumVCan,
        sumVSaldoExec,
        mediaDias
      };
    }, [matrixAggregatedData]);
    const matrixUniqueCounts = useMemo(() => {
      const contratos = new Set(),
        empenhos = new Set(),
        secLogs = new Set();
      filteredData.forEach(d => {
        if (d.contrato && d.contrato !== '-') contratos.add(d.contrato);
        if (d.empenho && d.empenho !== '-' && d.contrato && d.contrato !== '-') empenhos.add(`${d.contrato}|${d.empenho}`);
        if (d.sec_log && d.sec_log !== '-') secLogs.add(d.sec_log);
      });
      return {
        contratos: contratos.size,
        empenhos: empenhos.size,
        secLogs: secLogs.size
      };
    }, [filteredData]);
    const matrixUniqueContratos = matrixUniqueCounts.contratos;
    const matrixUniqueEmpenhos = matrixUniqueCounts.empenhos;
    const matrixUniqueSecLogs = matrixUniqueCounts.secLogs;
    const matrixShowsSecLog = matrixGroupBy === 'sec_log' || matrixGroupBy === 'sec_log_contrato_empenho';
    const matrixShowsContrato = matrixGroupBy !== 'sec_log' && matrixGroupBy !== 'empenho';
    const matrixShowsEmpenho = matrixGroupBy === 'empenho' || matrixGroupBy === 'contrato_empenho' || matrixGroupBy === 'sec_log_contrato_empenho';
    const matrixShowsFavorecido = matrixGroupBy === 'contrato_favorecido' || matrixGroupBy === 'contrato_favorecido_objeto';
    const matrixShowsObjeto = matrixGroupBy === 'contrato_favorecido_objeto';
    const matrixShowsNd = matrixGroupBy === 'contrato_nd';
    const matrixLeadingColsCount = (matrixShowsSecLog ? 1 : 0) + (matrixShowsContrato ? 1 : 0) + (matrixShowsEmpenho ? 1 : 0) + (matrixShowsFavorecido ? 1 : 0) + (matrixShowsObjeto ? 1 : 0) + (matrixShowsNd ? 1 : 0);
    const renderMatrixHeader = function (label, key) {
      let extraClass = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : "";
      const isSorted = matrixSort.key === key;
      return /*#__PURE__*/React.createElement("th", {
        className: `p-3 whitespace-nowrap cursor-pointer hover:bg-slate-200 transition ${extraClass}`,
        onClick: () => handleMatrixSort(key)
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-1 justify-center"
      }, label, /*#__PURE__*/React.createElement("span", {
        className: "text-[8px] text-slate-400"
      }, isSorted ? matrixSort.direction === 'asc' ? '▲' : '▼' : '↕')));
    };
    const getMasterExportCols = () => {
      let cols = [];
      if (masterCols.dia) cols.push({
        header: "DIA",
        key: "dia"
      });
      if (masterCols.contrato) cols.push({
        header: "CONTRATO/COMPRA",
        key: "contrato",
        format: r => `${r.contrato}\nCompra: ${r.compra}\nMod: ${r.modalidade}`
      });
      if (masterCols.arquivos) cols.push(...ContractFiles.exportColumns());
      if (masterCols.sec_log) cols.push({
        header: "SEC LOG",
        key: "sec_log"
      });
      if (masterCols.existencia) cols.push({
        header: "EXISTÊNCIA",
        key: "existencia"
      });
      if (masterCols.situacao) cols.push({
        header: "SITUAÇÃO",
        key: "situacao"
      });
      if (masterCols.movimento) cols.push({
        header: "MOVIMENTO",
        key: "movimentoStr"
      });
      if (masterCols.diasAss) cols.push({
        header: "DIAS ATÉ ASS. (RO)",
        key: "diasAss"
      });
      if (masterCols.vigencia) {
        cols.push({
          header: "VIG. INIC",
          key: "data_inic"
        });
        cols.push({
          header: "VIG. FIM",
          key: "data_fim"
        });
      }
      if (masterCols.perc_tempo) cols.push({
        header: "% TEMPO",
        key: "perc_tempo",
        isPercent: true
      });
      if (masterCols.emitente) cols.push({
        header: "EMITENTE",
        key: "ug"
      });
      if (masterCols.favorecido) cols.push({
        header: "FAVORECIDO",
        key: "favorecido"
      });
      if (masterCols.objeto) cols.push({
        header: "OBJETO",
        key: "objeto"
      });
      if (masterCols.gestor) {
        cols.push({
          header: "GESTOR",
          key: "gestor"
        });
        cols.push({
          header: "FISCAL",
          key: "fiscal"
        });
      }
      if (masterCols.empenho) cols.push({
        header: "EMPENHO",
        key: "empenho"
      });
      if (masterCols.documento) cols.push({
        header: "DOCUMENTO",
        key: "documento"
      });
      if (masterCols.obs) cols.push({
        header: "OBS",
        key: "obs"
      });
      if (masterCols.v_emp) cols.push({
        header: "EMPENHADO",
        key: "v_empenhado",
        isCurrency: true
      });
      if (masterCols.v_rec) cols.push({
        header: "RECEBIDO",
        key: "v_recebido",
        isCurrency: true
      });
      if (masterCols.v_liq) cols.push({
        header: "LIQUIDADO",
        key: "v_liquidado",
        isCurrency: true
      });
      if (masterCols.v_pag) cols.push({
        header: "PAGO",
        key: "v_pago",
        isCurrency: true
      });
      if (masterCols.v_can) cols.push({
        header: "CANCELADO",
        key: "v_cancelado",
        isCurrency: true
      });
      if (masterCols.v_bloq) cols.push({
        header: "BLOQUEADO",
        key: "v_bloqueado",
        isCurrency: true
      });
      return cols;
    };
    const getMatrixExportColumns = () => {
      let cols = [];
      if (matrixShowsSecLog) cols.push({
        header: "SEC LOG",
        key: "sec_log"
      });
      if (matrixShowsContrato) cols.push({
        header: "CONTRATO",
        key: "contrato",
        format: r => `${r.contrato}\nCompra: ${r.compra}\nMod: ${r.modalidade}`
      });
      if (matrixShowsEmpenho) cols.push({
        header: "EMPENHO",
        key: "empenho"
      });
      if (matrixShowsFavorecido) cols.push({
        header: "FAVORECIDO",
        key: "favorecido"
      });
      if (matrixShowsObjeto) cols.push({
        header: "OBJETO",
        key: "objeto"
      });
      if (matrixShowsNd) cols.push({
        header: "ND CÓDIGO",
        key: "nd_codigo"
      });
      cols.push({
        header: "DIAS ATÉ ASS. (RO)",
        key: "diasAss"
      });
      if (matrixVisibleCols.emp) {
        cols.push({
          header: "QTD DOC EMP",
          key: "qtd_emp"
        });
        cols.push({
          header: "R$ EMPENHADO",
          key: "v_emp",
          isCurrency: true
        });
      }
      if (matrixVisibleCols.rec) {
        cols.push({
          header: "QTD DOC REC",
          key: "qtd_rec"
        });
        cols.push({
          header: "R$ RECEBIDO",
          key: "v_rec",
          isCurrency: true
        });
      }
      if (matrixVisibleCols.liq) {
        cols.push({
          header: "QTD DOC LIQ",
          key: "qtd_liq"
        });
        cols.push({
          header: "R$ LIQUIDADO",
          key: "v_liq",
          isCurrency: true
        });
      }
      if (matrixVisibleCols.pag) {
        cols.push({
          header: "QTD DOC PAG",
          key: "qtd_pag"
        });
        cols.push({
          header: "R$ PAGO",
          key: "v_pag",
          isCurrency: true
        });
      }
      if (matrixVisibleCols.bloq) {
        cols.push({
          header: "QTD DOC BLOQ",
          key: "qtd_bloq"
        });
        cols.push({
          header: "R$ BLOQUEADO",
          key: "v_bloq",
          isCurrency: true
        });
      }
      if (matrixVisibleCols.can) {
        cols.push({
          header: "QTD DOC CAN",
          key: "qtd_can"
        });
        cols.push({
          header: "R$ CANCELADO",
          key: "v_can",
          isCurrency: true
        });
      }
      if (matrixVisibleCols.saldo) cols.push({
        header: "R$ SALDO A EXEC",
        key: "v_saldo_exec",
        isCurrency: true
      });
      return cols;
    };
    let masterColSpanCount = 0;
    if (masterCols.dia) masterColSpanCount++;
    if (masterCols.contrato) masterColSpanCount++;
    if (masterCols.arquivos) masterColSpanCount++;
    if (masterCols.sec_log) masterColSpanCount++;
    if (masterCols.existencia) masterColSpanCount++;
    if (masterCols.situacao) masterColSpanCount++;
    if (masterCols.movimento) masterColSpanCount++;
    if (masterCols.diasAss) masterColSpanCount++;
    if (masterCols.vigencia) masterColSpanCount++;
    if (masterCols.perc_tempo) masterColSpanCount++;
    if (masterCols.emitente) masterColSpanCount++;
    if (masterCols.favorecido) masterColSpanCount++;
    if (masterCols.objeto) masterColSpanCount++;
    if (masterCols.gestor) masterColSpanCount++;
    if (masterCols.empenho) masterColSpanCount++;
    if (masterCols.documento) masterColSpanCount++;
    if (masterCols.obs) masterColSpanCount++;
    const documentFilterActive = !!(fExistencia.length || fMovimento.length || fUg.length || fFavorecido.length || fEmpenho.length || fDocumento.length || dDiaDe || dDiaAte || fOnlyBloqueado || fOnlyCancelado || searchContratoTabela || searchSituacaoTabela || searchExistenciaTabela || searchMovimentoTabela || searchEmitenteTabela || searchUgNome || searchEmpenho || searchDocumento || searchObs || searchObjeto || searchGestorTabela || searchSecLogTabela || Object.values(numFilters).some(v => v.min !== '' || v.max !== '') || Object.values(dateFilters).some(v => v.min || v.max));
    const contractKeys = useMemo(() => documentFilterActive ? new Set(filteredData.map(row => UnifiedData.key(row.contrato))) : null, [filteredData, documentFilterActive]);
    return {
      contractKeys,
      filteredRows: filteredData,
      rawRows: rawData,
      ready: processedPayload === payload && !!payload,
      dateRange: documentDateRange,
      options: filterOptions,
      budgetIndex,
      docStats,
      totals: totalsMaster,
      countSoGeral,
      countSoContabil,
      actions: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
        className: "flex flex-wrap gap-2"
      }, "                        ", /*#__PURE__*/React.createElement("button", {
        title: QuickActionHelp.onlyGeneral,
        onClick: () => toggleExistencia('GERAL'),
        className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${fExistencia.includes('GERAL') ? tagColorsMap['SÓ EM GERAL'].css + ' border-transparent shadow-inner ring-2 ring-amber-400 ring-offset-1' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`
      }, "S\xD3 GERAL"), /*#__PURE__*/React.createElement("button", {
        title: QuickActionHelp.onlyAccounting,
        onClick: () => toggleExistencia('CONTÁBIL'),
        className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${fExistencia.includes('CONTÁBIL') ? tagColorsMap['SÓ EM CONTÁBIL'].css + ' border-transparent shadow-inner ring-2 ring-orange-400 ring-offset-1' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`
      }, "S\xD3 CONT\xC1BIL")), /*#__PURE__*/React.createElement("h3", {
        className: "filter-subtitle"
      }, "Documentos e movimentos"), /*#__PURE__*/React.createElement("div", {
        className: "flex flex-wrap gap-2"
      }, "                        ", /*#__PURE__*/React.createElement("button", {
        title: QuickActionHelp.documents(7, ps7Doc, ts),
        onClick: toggleDoc7Dias,
        className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isDoc7DiasActive ? 'bg-blue-600 text-white border-blue-600 ring-2 ring-blue-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
      }, "DOC 7 DIAS ATR\xC1S"), /*#__PURE__*/React.createElement("button", {
        title: QuickActionHelp.documents(30, ps30Doc, ts),
        onClick: toggleDoc30Dias,
        className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isDoc30DiasActive ? 'bg-blue-600 text-white border-blue-600 ring-2 ring-blue-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
      }, "DOC 30 DIAS ATR\xC1S"), /*#__PURE__*/React.createElement("button", {
        title: QuickActionHelp.latestDocument(maxDateInfo.str),
        onClick: applyFilterUltimoDia,
        "aria-pressed": isUltimoDiaActive,
        className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded border shadow-sm ${isUltimoDiaActive ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-600 border-slate-200"}`
      }, "DIA \xDALTIMO DOC")), /*#__PURE__*/React.createElement("div", {
        className: "flex flex-wrap gap-2"
      }, "                        ", ['EMP', 'RCB', 'LIQ', 'PAG', 'BLOQ', 'CAN'].map(mov => {
        const isActive = fMovimento.includes(mov);
        let activeClass = '';
        if (mov === 'EMP') activeClass = 'bg-blue-600 text-white border-transparent ring-2 ring-blue-400 ring-offset-1';else if (mov === 'RCB') activeClass = 'bg-violet-600 text-white border-transparent ring-2 ring-violet-400 ring-offset-1';else if (mov === 'LIQ') activeClass = 'bg-amber-600 text-white border-transparent ring-2 ring-amber-400 ring-offset-1';else if (mov === 'PAG') activeClass = 'bg-emerald-600 text-white border-transparent ring-2 ring-emerald-400 ring-offset-1';else if (mov === 'BLOQ') activeClass = 'bg-orange-600 text-white border-transparent ring-2 ring-orange-400 ring-offset-1';else if (mov === 'CAN') activeClass = 'bg-red-600 text-white border-transparent ring-2 ring-red-400 ring-offset-1';
        return /*#__PURE__*/React.createElement("button", {
          key: mov,
          title: QuickActionHelp.movement(mov),
          onClick: () => toggleMovimento(mov),
          className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isActive ? activeClass : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
        }, mov);
      }))),
      filters: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h3", {
        className: "filter-subtitle"
      }, "Documentos"), /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-4"
      }, "                    ", /*#__PURE__*/React.createElement(MultiSelect, {
        label: "EMITENTE",
        options: filterOptions.ug,
        selected: fUg,
        onChange: setFUg
      }), /*#__PURE__*/React.createElement(MultiSelect, {
        label: "FAVORECIDO",
        options: filterOptions.favorecido,
        selected: fFavorecido,
        onChange: setFFavorecido
      }), /*#__PURE__*/React.createElement(MultiSelect, {
        label: "EMPENHO",
        options: filterOptions.empenho,
        selected: fEmpenho,
        onChange: setFEmpenho
      }), /*#__PURE__*/React.createElement(MultiSelect, {
        label: "DOCUMENTO",
        options: filterOptions.documento,
        selected: fDocumento,
        onChange: setFDocumento
      }), /*#__PURE__*/React.createElement(MultiSelect, {
        label: "EXIST\xCANCIA",
        options: filterOptions.existencia,
        selected: fExistencia,
        onChange: setFExistencia
      })), /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4"
      }, /*#__PURE__*/React.createElement(DateInput, {
        label: "DIA DOC (DE)",
        value: dDiaDe,
        onChange: setDDiaDe
      }), /*#__PURE__*/React.createElement(DateInput, {
        label: "DIA DOC (AT\xC9)",
        value: dDiaAte,
        onChange: setDDiaAte
      }))),
      indicators: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h3", {
        className: "filter-subtitle"
      }, "Documentos"), "                ", /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8"
      }, /*#__PURE__*/React.createElement(DocStatCard, {
        title: "Docs RO ou NE",
        count: docStats.rone.count,
        date: docStats.rone.latestDate,
        timestamp: docStats.rone.latestVal
      }), /*#__PURE__*/React.createElement(DocStatCard, {
        title: "Docs NS ou NL (Rec)",
        count: docStats.nsnl_rec.count,
        date: docStats.nsnl_rec.latestDate,
        timestamp: docStats.nsnl_rec.latestVal
      }), /*#__PURE__*/React.createElement(DocStatCard, {
        title: "Docs NS ou NL (Liq)",
        count: docStats.nsnl_liq.count,
        date: docStats.nsnl_liq.latestDate,
        timestamp: docStats.nsnl_liq.latestVal
      }), /*#__PURE__*/React.createElement(DocStatCard, {
        title: "Docs OB",
        count: docStats.ob.count,
        date: docStats.ob.latestDate,
        timestamp: docStats.ob.latestVal
      }), /*#__PURE__*/React.createElement(DocStatCard, {
        title: "Docs DF",
        count: docStats.df.count,
        date: docStats.df.latestDate,
        timestamp: docStats.df.latestVal
      }))),
      page4: activePage === 4 ? /*#__PURE__*/React.createElement(CollapsibleSection, {
        title: "PANORAMA GERAL DOS DOCUMENTOS",
        defaultOpen: false,
        globalTrigger: expandTrigger,
        globalState: globalExpandState
      }, /*#__PURE__*/React.createElement("div", {
        className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200 mb-8"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-center mb-4 border-b border-slate-100 pb-2 flex-wrap gap-2"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-xs font-black text-slate-800 uppercase"
      }, "\xDAltimos Lan\xE7amentos Cont\xE1beis (At\xE9 10 docs)"), documentDateRange.lastValue !== null && /*#__PURE__*/React.createElement("div", {
        className: "text-[10px] font-black text-red-600 bg-red-50 border border-red-200 px-2 py-1 rounded shadow-sm flex items-center gap-1 shrink-0"
      }, /*#__PURE__*/React.createElement("span", {
        className: "uppercase"
      }, "\xDAltimo Dia de Lan\xE7amento:"), /*#__PURE__*/React.createElement("span", {
        className: "text-[11px]"
      }, documentDateRange.lastDate))), /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 min-h-[300px]"
      }, /*#__PURE__*/React.createElement(LatestDocCard, {
        title: "EMPENHADO",
        docs: latestDocs.empenhado,
        metricField: "v_empenhado",
        colorClass: "border-blue-500 text-blue-700"
      }), /*#__PURE__*/React.createElement(LatestDocCard, {
        title: "RECEBIDO",
        docs: latestDocs.recebido,
        metricField: "v_recebido",
        colorClass: "border-violet-500 text-violet-700",
        showEmitente: true
      }), /*#__PURE__*/React.createElement(LatestDocCard, {
        title: "LIQUIDADO",
        docs: latestDocs.liquidado,
        metricField: "v_liquidado",
        colorClass: "border-amber-500 text-amber-600"
      }), /*#__PURE__*/React.createElement(LatestDocCard, {
        title: "PAGO",
        docs: latestDocs.pago,
        metricField: "v_pago",
        colorClass: "border-emerald-500 text-emerald-600"
      }))), /*#__PURE__*/React.createElement("div", {
        className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200 mb-10"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-center mb-4 border-b border-slate-100 pb-2 flex-wrap gap-2"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-xs font-black text-slate-800 uppercase"
      }, "Primeiros Lan\xE7amentos Cont\xE1beis (At\xE9 10 docs)"), documentDateRange.firstValue !== null && /*#__PURE__*/React.createElement("div", {
        className: "text-[10px] font-black text-red-600 bg-red-50 border border-red-200 px-2 py-1 rounded shadow-sm flex items-center gap-1 shrink-0"
      }, /*#__PURE__*/React.createElement("span", {
        className: "uppercase"
      }, "Primeiro Dia de Lan\xE7amento:"), /*#__PURE__*/React.createElement("span", {
        className: "text-[11px]"
      }, documentDateRange.firstDate))), /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 min-h-[300px]"
      }, /*#__PURE__*/React.createElement(LatestDocCard, {
        title: "EMPENHADO",
        docs: primeirosDocs.empenhado,
        metricField: "v_empenhado",
        colorClass: "border-blue-500 text-blue-700"
      }), /*#__PURE__*/React.createElement(LatestDocCard, {
        title: "RECEBIDO",
        docs: primeirosDocs.recebido,
        metricField: "v_recebido",
        colorClass: "border-violet-500 text-violet-700",
        showEmitente: true
      }), /*#__PURE__*/React.createElement(LatestDocCard, {
        title: "LIQUIDADO",
        docs: primeirosDocs.liquidado,
        metricField: "v_liquidado",
        colorClass: "border-amber-500 text-amber-600"
      }), /*#__PURE__*/React.createElement(LatestDocCard, {
        title: "PAGO",
        docs: primeirosDocs.pago,
        metricField: "v_pago",
        colorClass: "border-emerald-500 text-emerald-600"
      }))), /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-1 gap-8 mb-10"
      }, /*#__PURE__*/React.createElement("div", {
        className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-xs font-black text-slate-800 uppercase mb-4"
      }, "Composi\xE7\xE3o de Documentos"), /*#__PURE__*/React.createElement(DocumentComposition, {
        counts: docCounts,
        amounts: totalsMaster,
        uniqueDocs: totalUniqueDocs
      })), /*#__PURE__*/React.createElement("div", {
        className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col overflow-hidden"
      }, /*#__PURE__*/React.createElement("div", {
        className: "bg-slate-800 px-4 py-3 flex justify-between items-center flex-wrap gap-2"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-white text-xs font-black tracking-widest uppercase"
      }, "MATRIZ QTD DE DOCUMENTOS (", Math.min(matrixLimit, matrixData.length), " de ", matrixData.length, " \u2014 ", matrixShowsSecLog ? `${matrixUniqueSecLogs} SEC LOG | ` : "", matrixUniqueContratos, " Contratos | ", matrixUniqueEmpenhos, " Empenhos)"), /*#__PURE__*/React.createElement("div", {
        className: "flex gap-2 items-center"
      }, /*#__PURE__*/React.createElement("select", {
        value: matrixGroupBy,
        onChange: e => setMatrixGroupBy(e.target.value),
        className: "text-[9px] font-bold border border-slate-600 rounded px-2 py-1 outline-none shadow-sm text-white bg-slate-700"
      }, /*#__PURE__*/React.createElement("option", {
        value: "empenho"
      }, "Por empenho"), /*#__PURE__*/React.createElement("option", {
        value: "contrato"
      }, "Por contrato"), /*#__PURE__*/React.createElement("option", {
        value: "sec_log"
      }, "Por Sec Log"), /*#__PURE__*/React.createElement("option", {
        value: "contrato_empenho"
      }, "Por Contrato-Empenho"), /*#__PURE__*/React.createElement("option", {
        value: "contrato_favorecido"
      }, "Por Contrato-Favorecido"), /*#__PURE__*/React.createElement("option", {
        value: "contrato_favorecido_objeto"
      }, "Por Contrato-Favorecido-Objeto"), /*#__PURE__*/React.createElement("option", {
        value: "contrato_nd"
      }, "Por Contrato-ND"), /*#__PURE__*/React.createElement("option", {
        value: "sec_log_contrato_empenho"
      }, "Por Sec Log-Contrato-Empenho")), /*#__PURE__*/React.createElement("div", {
        className: "relative"
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => setShowMatrixCols(!showMatrixCols),
        className: "bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
      }, "COLUNAS \u25BC"), showMatrixCols && /*#__PURE__*/React.createElement("div", {
        className: "absolute right-0 mt-1 w-48 bg-white rounded shadow-lg border border-slate-200 z-50 p-2 flex flex-col gap-1"
      }, Object.keys(matrixVisibleCols).map(k => /*#__PURE__*/React.createElement("label", {
        key: k,
        className: "flex items-center gap-2 text-[10px] font-bold text-slate-700 cursor-pointer hover:bg-slate-50 p-1 rounded"
      }, /*#__PURE__*/React.createElement("input", {
        type: "checkbox",
        checked: matrixVisibleCols[k],
        onChange: () => setMatrixVisibleCols(p => ({
          ...p,
          [k]: !p[k]
        }))
      }), k === 'emp' ? 'EMPENHADO' : k === 'rec' ? 'RECEBIDO' : k === 'liq' ? 'LIQUIDADO' : k === 'pag' ? 'PAGO' : k === 'bloq' ? 'BLOQUEADO' : k === 'can' ? 'CANCELADO' : 'SALDO A EXEC')))), /*#__PURE__*/React.createElement("div", {
        className: "w-[1px] h-4 bg-slate-600 mx-1 hidden sm:block"
      }), /*#__PURE__*/React.createElement("button", {
        onClick: () => exportTable.toExcel(matrixData, "Matriz_Empenhos", getMatrixExportColumns()),
        className: "bg-green-600 hover:bg-green-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
      }, "EXCEL"), /*#__PURE__*/React.createElement("button", {
        onClick: () => exportTable.toCSV(matrixData, "Matriz_Empenhos", getMatrixExportColumns()),
        className: "bg-blue-600 hover:bg-blue-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
      }, "CSV"), /*#__PURE__*/React.createElement("button", {
        onClick: () => exportTable.toPDF(matrixData, "Matriz_Empenhos", getMatrixExportColumns(), "MATRIZ DE EMPENHOS"),
        className: "bg-red-600 hover:bg-red-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
      }, "PDF"))), /*#__PURE__*/React.createElement("div", {
        className: "overflow-x-auto overflow-y-auto flex-1 custom-scrollbar bg-white",
        style: {
          maxHeight: '550px'
        }
      }, /*#__PURE__*/React.createElement("table", {
        className: "w-full text-left text-[9px] border-collapse relative"
      }, /*#__PURE__*/React.createElement("thead", {
        className: "bg-slate-50 sticky top-0 border-b border-slate-200 shadow-sm z-10"
      }, /*#__PURE__*/React.createElement("tr", {
        className: "text-slate-600 uppercase font-black tracking-tighter"
      }, matrixShowsSecLog && renderMatrixHeader('SEC LOG', 'sec_log', 'text-left'), matrixShowsContrato && renderMatrixHeader('CONTRATO', 'contrato', 'text-left'), matrixShowsEmpenho && renderMatrixHeader('EMPENHO', 'empenho'), matrixShowsFavorecido && renderMatrixHeader('FAVORECIDO', 'favorecido', 'text-left'), matrixShowsObjeto && renderMatrixHeader('OBJETO', 'objeto', 'text-left'), matrixShowsNd && renderMatrixHeader('ND CÓDIGO', 'nd_codigo', 'text-left'), /*#__PURE__*/React.createElement("th", {
        className: "p-3 whitespace-nowrap text-center cursor-pointer hover:bg-slate-200 transition",
        title: "Dias do RO mais antigo at\xE9 Vig\xEAncia Incial",
        onClick: () => handleMatrixSort('diasAss')
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-1 justify-center"
      }, "DIAS AT\xC9 ASS. (RO) ", /*#__PURE__*/React.createElement("span", {
        className: "text-[8px] text-slate-400"
      }, matrixSort.key === 'diasAss' ? matrixSort.direction === 'asc' ? '▲' : '▼' : '↕'))), matrixVisibleCols.emp && /*#__PURE__*/React.createElement(React.Fragment, null, renderMatrixHeader('QTD DOC EMP', 'qtd_emp', 'text-blue-700'), " ", renderMatrixHeader('R$ EMPENHADO', 'v_emp', 'text-blue-700 text-right')), matrixVisibleCols.rec && /*#__PURE__*/React.createElement(React.Fragment, null, renderMatrixHeader('QTD DOC REC', 'qtd_rec', 'text-violet-700'), " ", renderMatrixHeader('R$ RECEBIDO', 'v_rec', 'text-violet-700 text-right')), matrixVisibleCols.liq && /*#__PURE__*/React.createElement(React.Fragment, null, renderMatrixHeader('QTD DOC LIQ', 'qtd_liq', 'text-amber-700'), " ", renderMatrixHeader('R$ LIQUIDADO', 'v_liq', 'text-amber-700 text-right')), matrixVisibleCols.pag && /*#__PURE__*/React.createElement(React.Fragment, null, renderMatrixHeader('QTD DOC PAG', 'qtd_pag', 'text-emerald-700'), " ", renderMatrixHeader('R$ PAGO', 'v_pag', 'text-emerald-700 text-right')), matrixVisibleCols.bloq && /*#__PURE__*/React.createElement(React.Fragment, null, renderMatrixHeader('QTD DOC BLOQ', 'qtd_bloq', 'text-orange-700'), " ", renderMatrixHeader('R$ BLOQUEADO', 'v_bloq', 'text-orange-700 text-right')), matrixVisibleCols.can && /*#__PURE__*/React.createElement(React.Fragment, null, renderMatrixHeader('QTD DOC CAN', 'qtd_can', 'text-red-700'), " ", renderMatrixHeader('R$ CANCELADO', 'v_can', 'text-red-700 text-right')), matrixVisibleCols.saldo && renderMatrixHeader('R$ SALDO A EXEC', 'v_saldo_exec', 'text-teal-700 text-right'))), /*#__PURE__*/React.createElement("tbody", {
        className: "divide-y divide-slate-100"
      }, matrixData.slice(0, matrixLimit).map(row => /*#__PURE__*/React.createElement("tr", {
        key: row.groupKey,
        className: "hover:bg-slate-50 transition-colors"
      }, matrixShowsSecLog && /*#__PURE__*/React.createElement("td", {
        className: "p-3 font-black text-slate-700 break-words min-w-[120px]"
      }, row.sec_log), matrixShowsContrato && /*#__PURE__*/React.createElement("td", {
        className: "p-3 font-black text-slate-800 break-words min-w-[150px]"
      }, /*#__PURE__*/React.createElement(ContratoCell, {
        row: row
      })), matrixShowsEmpenho && /*#__PURE__*/React.createElement("td", {
        className: "p-3 font-bold text-slate-600 break-words text-center whitespace-nowrap"
      }, /*#__PURE__*/React.createElement(PortalDocumentLink, {
        value: row.empenho,
        context: row
      })), matrixShowsFavorecido && /*#__PURE__*/React.createElement("td", {
        className: "p-3 font-bold text-slate-700 break-words min-w-[180px]"
      }, row.favorecido), matrixShowsObjeto && /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-slate-600 break-words min-w-[240px]"
      }, row.objeto), matrixShowsNd && /*#__PURE__*/React.createElement("td", {
        className: "p-3 font-bold text-slate-700 break-words min-w-[120px]"
      }, row.nd_codigo), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center align-middle"
      }, row.diasAss !== null ? /*#__PURE__*/React.createElement("span", {
        className: `px-2 py-1 rounded font-bold text-[9px] ${row.diasAss >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`
      }, row.diasAss, " d") : '-'), matrixVisibleCols.emp && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center font-bold text-blue-600 bg-blue-50/30",
        "data-metric": "empenhado",
        style: MetricColors.textStyle('empenhado')
      }, row.qtd_emp), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right font-black text-blue-700 bg-blue-50/30 whitespace-nowrap",
        "data-metric": "empenhado",
        style: MetricColors.textStyle('empenhado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_emp
      }))), matrixVisibleCols.rec && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center font-bold text-violet-600 bg-violet-50/30"
      }, row.qtd_rec), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right font-black text-violet-700 bg-violet-50/30 whitespace-nowrap"
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_rec
      }))), matrixVisibleCols.liq && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center font-bold text-amber-600 bg-amber-50/30",
        "data-metric": "liquidado",
        style: MetricColors.textStyle('liquidado')
      }, row.qtd_liq), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right font-black text-amber-700 bg-amber-50/30 whitespace-nowrap",
        "data-metric": "liquidado",
        style: MetricColors.textStyle('liquidado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_liq
      }))), matrixVisibleCols.pag && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center font-bold text-emerald-600 bg-emerald-50/30",
        "data-metric": "pago",
        style: MetricColors.textStyle('pago')
      }, row.qtd_pag), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right font-black text-emerald-700 bg-emerald-50/30 whitespace-nowrap",
        "data-metric": "pago",
        style: MetricColors.textStyle('pago')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_pag
      }))), matrixVisibleCols.bloq && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center font-bold text-orange-600 bg-orange-50/30",
        "data-metric": "bloqueado",
        style: MetricColors.textStyle('bloqueado')
      }, row.qtd_bloq), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right font-black text-orange-700 bg-orange-50/30 whitespace-nowrap",
        "data-metric": "bloqueado",
        style: MetricColors.textStyle('bloqueado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_bloq
      }))), matrixVisibleCols.can && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center font-bold text-red-600 bg-red-50/30",
        "data-metric": "cancelado",
        style: MetricColors.textStyle('cancelado')
      }, row.qtd_can), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right font-black text-red-700 bg-red-50/30 whitespace-nowrap",
        "data-metric": "cancelado",
        style: MetricColors.textStyle('cancelado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_can
      }))), matrixVisibleCols.saldo && /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right font-black text-teal-700 bg-teal-50/30 whitespace-nowrap"
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_saldo_exec
      })))), matrixData.length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
        colSpan: "20",
        className: "p-4 text-center text-slate-400 font-bold"
      }, "Sem dados para a matriz."))), /*#__PURE__*/React.createElement("tfoot", {
        className: "bg-slate-200 sticky bottom-0 border-t-2 border-slate-300 shadow-md z-10"
      }, /*#__PURE__*/React.createElement("tr", {
        className: "text-slate-700 uppercase font-black"
      }, /*#__PURE__*/React.createElement("td", {
        colSpan: matrixLeadingColsCount,
        className: "p-3 text-right"
      }, "TOTAIS:"), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center align-middle"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-[10px]"
      }, matrixTotals.mediaDias !== '-' ? `${matrixTotals.mediaDias} d (Média)` : '-'), /*#__PURE__*/React.createElement("div", {
        className: "text-[7px] text-slate-500 font-bold leading-tight mt-0.5"
      }, "*Exclui vals. negativos")), matrixVisibleCols.emp && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center text-blue-800",
        "data-metric": "empenhado",
        style: MetricColors.textStyle('empenhado')
      }, matrixTotals.sumQtdEmp), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right text-blue-800 whitespace-nowrap",
        "data-metric": "empenhado",
        style: MetricColors.textStyle('empenhado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: matrixTotals.sumVEmp
      }))), matrixVisibleCols.rec && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center text-violet-800"
      }, matrixTotals.sumQtdRec), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right text-violet-800 whitespace-nowrap"
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: matrixTotals.sumVRec
      }))), matrixVisibleCols.liq && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center text-amber-800",
        "data-metric": "liquidado",
        style: MetricColors.textStyle('liquidado')
      }, matrixTotals.sumQtdLiq), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right text-amber-800 whitespace-nowrap",
        "data-metric": "liquidado",
        style: MetricColors.textStyle('liquidado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: matrixTotals.sumVLiq
      }))), matrixVisibleCols.pag && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center text-emerald-800",
        "data-metric": "pago",
        style: MetricColors.textStyle('pago')
      }, matrixTotals.sumQtdPag), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right text-emerald-800 whitespace-nowrap",
        "data-metric": "pago",
        style: MetricColors.textStyle('pago')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: matrixTotals.sumVPag
      }))), matrixVisibleCols.bloq && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center text-orange-800",
        "data-metric": "bloqueado",
        style: MetricColors.textStyle('bloqueado')
      }, matrixTotals.sumQtdBloq), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right text-orange-800 whitespace-nowrap",
        "data-metric": "bloqueado",
        style: MetricColors.textStyle('bloqueado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: matrixTotals.sumVBloq
      }))), matrixVisibleCols.can && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-center text-red-800",
        "data-metric": "cancelado",
        style: MetricColors.textStyle('cancelado')
      }, matrixTotals.sumQtdCan), /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right text-red-800 whitespace-nowrap",
        "data-metric": "cancelado",
        style: MetricColors.textStyle('cancelado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: matrixTotals.sumVCan
      }))), matrixVisibleCols.saldo && /*#__PURE__*/React.createElement("td", {
        className: "p-3 text-right text-teal-800 whitespace-nowrap"
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: matrixTotals.sumVSaldoExec
      })))))), matrixLimit < matrixData.length && /*#__PURE__*/React.createElement("div", {
        className: "p-4 bg-slate-50 border-t flex justify-center"
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => setMatrixLimit(prev => prev + 100),
        className: "bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs px-6 py-2 rounded transition border border-slate-300 shadow-sm cursor-pointer"
      }, "Ver mais (+100)"))))) : null,
      page5: activePage === 5 ? /*#__PURE__*/React.createElement(CollapsibleSection, {
        title: "TABELAS DE EXECU\xC7\xC3O DOS DOCUMENTOS",
        defaultOpen: false,
        globalTrigger: expandTrigger,
        globalState: globalExpandState
      }, /*#__PURE__*/React.createElement("div", {
        className: "bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden mb-10"
      }, /*#__PURE__*/React.createElement("div", {
        className: "bg-slate-800 px-4 py-3 flex justify-between items-center flex-wrap gap-2"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-white text-xs font-black tracking-widest uppercase"
      }, "Detalhamento Master (", Math.min(visibleRows, filteredData.length), " de ", filteredData.length, ")"), /*#__PURE__*/React.createElement("div", {
        className: "flex gap-2 items-center"
      }, /*#__PURE__*/React.createElement("div", {
        className: "relative"
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => setShowMasterColsMenu(!showMasterColsMenu),
        className: "bg-slate-700 hover:bg-slate-600 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
      }, "COLUNAS \u25BC"), showMasterColsMenu && /*#__PURE__*/React.createElement("div", {
        className: "absolute right-0 mt-1 w-48 bg-white rounded shadow-lg border border-slate-200 z-50 p-2 flex flex-col gap-1 max-h-64 overflow-y-auto custom-scrollbar"
      }, Object.keys(masterCols).map(k => /*#__PURE__*/React.createElement("label", {
        key: k,
        className: "flex items-center gap-2 text-[10px] font-bold text-slate-700 cursor-pointer hover:bg-slate-50 p-1 rounded"
      }, /*#__PURE__*/React.createElement("input", {
        type: "checkbox",
        checked: masterCols[k],
        onChange: () => setMasterCols(p => ({
          ...p,
          [k]: !p[k]
        }))
      }), k.toUpperCase().replace('_', ' '))))), /*#__PURE__*/React.createElement("div", {
        className: "w-[1px] h-4 bg-slate-600 mx-1 hidden sm:block"
      }), /*#__PURE__*/React.createElement("button", {
        onClick: () => exportTable.toExcel(filteredData, "Master_Contabil", getMasterExportCols()),
        className: "bg-green-600 hover:bg-green-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
      }, "EXCEL"), /*#__PURE__*/React.createElement("button", {
        onClick: () => exportTable.toCSV(filteredData, "Master_Contabil", getMasterExportCols()),
        className: "bg-blue-600 hover:bg-blue-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
      }, "CSV"), /*#__PURE__*/React.createElement("button", {
        onClick: () => exportTable.toPDF(filteredData, "Master_Contabil", getMasterExportCols(), "DETALHAMENTO MASTER"),
        className: "bg-red-600 hover:bg-red-500 text-white text-[9px] font-black px-2 py-1 rounded shadow transition"
      }, "PDF"))), /*#__PURE__*/React.createElement("div", {
        className: "overflow-x-auto max-h-[600px] overflow-y-auto custom-scrollbar"
      }, /*#__PURE__*/React.createElement("table", {
        className: "text-left text-[9px] border-collapse relative",
        style: {
          tableLayout: 'fixed',
          width: '100%',
          minWidth: '2700px'
        }
      }, /*#__PURE__*/React.createElement("thead", {
        className: "bg-slate-50 sticky top-0 border-b border-slate-200 shadow-sm z-10"
      }, /*#__PURE__*/React.createElement("tr", {
        className: "text-slate-600 uppercase font-black tracking-tighter align-top"
      }, masterCols.dia && /*#__PURE__*/React.createElement(DateFilterHeader, {
        widthClass: "w-[5%]",
        label: "DIA",
        field: "dia",
        current: sortConfig,
        onSort: handleSort,
        dateFilters: dateFilters,
        setDateFilters: setDateFilters
      }), masterCols.contrato && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[8%]",
        label: "CONTRATO/COMPRA",
        field: "contrato",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchContratoTabela,
        onSearchChange: setSearchContratoTabela
      }), masterCols.arquivos && /*#__PURE__*/React.createElement("th", {
        scope: "col",
        className: "w-[76px] min-w-[76px] p-2 align-top text-center sm:w-[140px] sm:min-w-[140px]"
      }, "ARQUIVOS"), masterCols.sec_log && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[5%]",
        label: "SEC LOG",
        field: "sec_log",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchSecLogTabela,
        onSearchChange: setSearchSecLogTabela
      }), masterCols.existencia && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[6%]",
        label: "EXIST\xCANCIA",
        field: "existencia",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchExistenciaTabela,
        onSearchChange: setSearchExistenciaTabela,
        align: "center"
      }), masterCols.situacao && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[6%]",
        label: "SITUA\xC7\xC3O",
        field: "situacao",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchSituacaoTabela,
        onSearchChange: setSearchSituacaoTabela,
        align: "center"
      }), masterCols.movimento && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[6%]",
        label: "MOVIMENTO",
        field: "movimentoStr",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchMovimentoTabela,
        onSearchChange: setSearchMovimentoTabela,
        align: "center"
      }), masterCols.diasAss && /*#__PURE__*/React.createElement(NumericHeader, {
        widthClass: "w-[5%]",
        label: "DIAS ASS (RO)",
        field: "diasAss",
        current: sortConfig,
        onSort: handleSort,
        numFilters: numFilters,
        setNumFilters: setNumFilters,
        align: "center"
      }), masterCols.vigencia && /*#__PURE__*/React.createElement(DateFilterHeader, {
        widthClass: "w-[6%]",
        label: "VIG\xCANCIA",
        field: "data_inic",
        current: sortConfig,
        onSort: handleSort,
        dateFilters: dateFilters,
        setDateFilters: setDateFilters,
        align: "center"
      }), masterCols.perc_tempo && /*#__PURE__*/React.createElement(NumericHeader, {
        widthClass: "w-[6%]",
        label: "% TEMPO",
        field: "perc_tempo",
        current: sortConfig,
        onSort: handleSort,
        numFilters: numFilters,
        setNumFilters: setNumFilters,
        align: "center"
      }), masterCols.emitente && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[6%]",
        label: "EMITENTE",
        field: "ug",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchEmitenteTabela,
        onSearchChange: setSearchEmitenteTabela
      }), masterCols.favorecido && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[12%]",
        label: "FAVORECIDO",
        field: "favorecido",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchUgNome,
        onSearchChange: setSearchUgNome
      }), masterCols.objeto && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[10%]",
        label: "OBJETO",
        field: "objeto",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchObjeto,
        onSearchChange: setSearchObjeto
      }), masterCols.gestor && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[7%]",
        label: "GESTOR/FISCAL",
        field: "gestor",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchGestorTabela,
        onSearchChange: setSearchGestorTabela
      }), masterCols.empenho && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[8%]",
        label: "EMPENHO",
        field: "empenho",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchEmpenho,
        onSearchChange: setSearchEmpenho
      }), masterCols.documento && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[8%]",
        label: "DOCUMENTO",
        field: "documento",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchDocumento,
        onSearchChange: setSearchDocumento
      }), masterCols.obs && /*#__PURE__*/React.createElement(TextHeader, {
        widthClass: "w-[12%]",
        label: "OBS",
        field: "obs",
        current: sortConfig,
        onSort: handleSort,
        searchVal: searchObs,
        onSearchChange: setSearchObs
      }), masterCols.v_emp && /*#__PURE__*/React.createElement(NumericHeader, {
        widthClass: "w-[6%]",
        label: "EMPENHADO",
        field: "v_empenhado",
        current: sortConfig,
        onSort: handleSort,
        numFilters: numFilters,
        setNumFilters: setNumFilters,
        align: "right"
      }), masterCols.v_rec && /*#__PURE__*/React.createElement(NumericHeader, {
        widthClass: "w-[6%]",
        label: "RECEBIDO",
        field: "v_recebido",
        current: sortConfig,
        onSort: handleSort,
        numFilters: numFilters,
        setNumFilters: setNumFilters,
        align: "right"
      }), masterCols.v_liq && /*#__PURE__*/React.createElement(NumericHeader, {
        widthClass: "w-[6%]",
        label: "LIQUIDADO",
        field: "v_liquidado",
        current: sortConfig,
        onSort: handleSort,
        numFilters: numFilters,
        setNumFilters: setNumFilters,
        align: "right"
      }), masterCols.v_pag && /*#__PURE__*/React.createElement(NumericHeader, {
        widthClass: "w-[6%]",
        label: "PAGO",
        field: "v_pago",
        current: sortConfig,
        onSort: handleSort,
        numFilters: numFilters,
        setNumFilters: setNumFilters,
        align: "right"
      }), masterCols.v_can && /*#__PURE__*/React.createElement(NumericHeader, {
        widthClass: "w-[6%]",
        label: "CANCELADO",
        field: "v_cancelado",
        current: sortConfig,
        onSort: handleSort,
        numFilters: numFilters,
        setNumFilters: setNumFilters,
        align: "right"
      }), masterCols.v_bloq && /*#__PURE__*/React.createElement(NumericHeader, {
        widthClass: "w-[6%]",
        label: "BLOQUEADO",
        field: "v_bloqueado",
        current: sortConfig,
        onSort: handleSort,
        numFilters: numFilters,
        setNumFilters: setNumFilters,
        align: "right"
      }))), /*#__PURE__*/React.createElement("tbody", {
        className: "divide-y divide-slate-100"
      }, filteredData.slice(0, visibleRows).map((row, i) => /*#__PURE__*/React.createElement("tr", {
        key: i,
        className: "hover:bg-blue-50 transition-colors"
      }, masterCols.dia && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-slate-500 font-bold whitespace-normal break-words"
      }, row.dia || "-"), masterCols.contrato && /*#__PURE__*/React.createElement("td", {
        className: "p-2 align-top min-w-[150px]"
      }, /*#__PURE__*/React.createElement(ContratoCell, {
        row: row
      })), masterCols.arquivos && /*#__PURE__*/React.createElement("td", {
        className: "p-2 align-top"
      }, /*#__PURE__*/React.createElement(ContractFilesCell, {
        row: row
      })), masterCols.sec_log && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-slate-500 font-bold whitespace-normal break-words"
      }, row.sec_log), masterCols.existencia && /*#__PURE__*/React.createElement("td", {
        className: "p-2 align-middle text-center"
      }, /*#__PURE__*/React.createElement("span", {
        className: `text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${row.existencia === 'AMBAS' ? 'bg-blue-100 text-blue-700 border border-blue-200' : row.existencia === 'GERAL' ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-orange-100 text-orange-800 border border-orange-200'}`
      }, row.existencia)), masterCols.situacao && /*#__PURE__*/React.createElement("td", {
        className: "p-2 align-middle text-center"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex flex-wrap items-center justify-center gap-1"
      }, row.situacaoFlags && row.situacaoFlags.map((f, idx) => /*#__PURE__*/React.createElement("span", {
        key: idx,
        className: `text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${f.color}`
      }, f.label)))), masterCols.movimento && /*#__PURE__*/React.createElement("td", {
        className: "p-2 align-middle text-center"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex flex-wrap items-center justify-center gap-1"
      }, row.movimentoFlags && row.movimentoFlags.map((f, idx) => /*#__PURE__*/React.createElement("span", {
        key: idx,
        className: `text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${f.color}`
      }, f.label)))), masterCols.diasAss && /*#__PURE__*/React.createElement("td", {
        className: "p-2 align-middle text-center font-bold text-slate-600"
      }, row.diasAss !== null ? /*#__PURE__*/React.createElement("span", {
        className: `px-1.5 py-0.5 rounded ${row.diasAss >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`
      }, row.diasAss, " d") : "-"), masterCols.vigencia && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-slate-500 font-bold whitespace-normal break-words text-center"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-[9px] text-slate-400"
      }, "In\xED: ", row.data_inic || "-"), /*#__PURE__*/React.createElement("div", {
        className: "text-[9px] mt-1 text-slate-600"
      }, "Fim: ", row.data_fim || "-")), masterCols.perc_tempo && /*#__PURE__*/React.createElement("td", {
        className: "p-2 align-middle"
      }, row.perc_tempo !== null ? /*#__PURE__*/React.createElement("div", {
        className: "flex flex-col gap-1"
      }, /*#__PURE__*/React.createElement("div", {
        className: "text-[8px] font-bold text-slate-500 text-center"
      }, row.dias_passaram, " d decorridos"), /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-1"
      }, /*#__PURE__*/React.createElement("div", {
        className: "w-full bg-slate-200 rounded-full h-1.5 flex-1 overflow-hidden"
      }, /*#__PURE__*/React.createElement("div", {
        className: `h-1.5 rounded-full ${row.perc_tempo >= 1 ? 'bg-red-500' : 'bg-emerald-500'}`,
        style: {
          width: `${Math.min(Math.max(row.perc_tempo * 100, 0), 100)}%`
        }
      })), /*#__PURE__*/React.createElement("span", {
        className: "text-[8px] font-bold text-slate-600 min-w-[30px] text-right"
      }, formatPercentBR(row.perc_tempo))), /*#__PURE__*/React.createElement("div", {
        className: "text-[8px] font-bold text-center mt-0.5"
      }, /*#__PURE__*/React.createElement("span", {
        className: row.encerrando_dias < 0 ? 'text-red-500' : 'text-emerald-600'
      }, row.encerrando_dias, " d restantes"))) : "-"), masterCols.emitente && /*#__PURE__*/React.createElement("td", {
        className: "p-2 font-bold text-slate-700 whitespace-normal break-words"
      }, row.ug), masterCols.favorecido && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-slate-600 font-bold whitespace-normal break-words leading-tight"
      }, /*#__PURE__*/React.createElement(CounterpartyLink, {
        name: row.favorecido,
        identifier: row.favorecido_cnpj,
        title: "Abrir favorecido no Portal da Transpar\xEAncia"
      })), masterCols.objeto && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-slate-500 whitespace-normal break-words leading-tight"
      }, row.objeto), masterCols.gestor && /*#__PURE__*/React.createElement("td", {
        className: "p-2 whitespace-normal break-words"
      }, /*#__PURE__*/React.createElement("div", {
        className: "font-bold text-slate-700",
        title: "Gestor"
      }, "G: ", row.gestor), /*#__PURE__*/React.createElement("div", {
        className: "font-bold text-slate-700 mt-1",
        title: "Fiscal"
      }, "F: ", row.fiscal)), masterCols.empenho && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-slate-600 font-bold whitespace-normal break-words"
      }, row.empenho && /*#__PURE__*/React.createElement(PortalDocumentLink, {
        value: row.empenho,
        context: row
      })), masterCols.documento && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-slate-600 font-bold whitespace-normal break-words"
      }, row.documento && /*#__PURE__*/React.createElement(PortalDocumentLink, {
        value: row.documento,
        context: row
      })), masterCols.obs && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-slate-500 whitespace-normal break-words leading-tight"
      }, row.obs), masterCols.v_emp && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right font-bold text-blue-700 whitespace-normal break-words bg-blue-50/30",
        "data-metric": "empenhado",
        style: MetricColors.textStyle('empenhado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_empenhado
      })), masterCols.v_rec && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right font-bold text-violet-600 whitespace-normal break-words"
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_recebido
      })), masterCols.v_liq && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right font-bold text-amber-600 whitespace-normal break-words bg-amber-50/30",
        "data-metric": "liquidado",
        style: MetricColors.textStyle('liquidado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_liquidado
      })), masterCols.v_pag && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right font-black text-emerald-600 whitespace-normal break-words",
        "data-metric": "pago",
        style: MetricColors.textStyle('pago')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_pago
      })), masterCols.v_can && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right font-bold text-red-600 whitespace-normal break-words bg-red-50/30",
        "data-metric": "cancelado",
        style: MetricColors.textStyle('cancelado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_cancelado
      })), masterCols.v_bloq && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right font-bold text-orange-600 whitespace-normal break-words",
        "data-metric": "bloqueado",
        style: MetricColors.textStyle('bloqueado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: row.v_bloqueado
      }))))), /*#__PURE__*/React.createElement("tfoot", {
        className: "bg-slate-200 sticky bottom-0 border-t-2 border-slate-300 shadow-md z-10"
      }, /*#__PURE__*/React.createElement("tr", {
        className: "text-slate-700 uppercase font-black"
      }, masterColSpanCount > 0 && /*#__PURE__*/React.createElement("td", {
        colSpan: masterColSpanCount,
        className: "p-2 text-right"
      }, "TOTAIS:"), masterCols.v_emp && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right text-blue-800",
        "data-metric": "empenhado",
        style: MetricColors.textStyle('empenhado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: totalsMaster.emp
      })), masterCols.v_rec && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right text-violet-800"
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: totalsMaster.rec
      })), masterCols.v_liq && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right text-amber-800",
        "data-metric": "liquidado",
        style: MetricColors.textStyle('liquidado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: totalsMaster.liq
      })), masterCols.v_pag && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right text-emerald-800",
        "data-metric": "pago",
        style: MetricColors.textStyle('pago')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: totalsMaster.pag
      })), masterCols.v_can && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right text-red-800",
        "data-metric": "cancelado",
        style: MetricColors.textStyle('cancelado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: totalsMaster.can
      })), masterCols.v_bloq && /*#__PURE__*/React.createElement("td", {
        className: "p-2 text-right text-orange-800",
        "data-metric": "bloqueado",
        style: MetricColors.textStyle('bloqueado')
      }, /*#__PURE__*/React.createElement(FormatNegativeValue, {
        val: totalsMaster.blo
      })))))), visibleRows < filteredData.length && /*#__PURE__*/React.createElement("div", {
        className: "p-4 bg-slate-50 border-t flex justify-center"
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => setVisibleRows(prev => prev + 100),
        className: "bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs px-6 py-2 rounded transition border border-slate-300 shadow-sm cursor-pointer"
      }, "Ver mais (+100)"))), /*#__PURE__*/React.createElement("div", {
        className: "grid grid-cols-1 lg:grid-cols-2 gap-8 mb-10"
      }, /*#__PURE__*/React.createElement(SubTable, {
        title: "Detalhamento - Empenhado",
        data: filteredData,
        metricField: "v_empenhado",
        metricLabel: "EMPENHADO",
        headerColor: "bg-blue-800",
        textColor: "text-blue-700",
        rowBgColor: "bg-blue-50/30",
        showDiasAss: true
      }), /*#__PURE__*/React.createElement(SubTable, {
        title: "Detalhamento - Recebido",
        data: filteredData,
        metricField: "v_recebido",
        metricLabel: "RECEBIDO",
        headerColor: "bg-violet-800",
        textColor: "text-violet-700",
        rowBgColor: ""
      }), /*#__PURE__*/React.createElement(SubTable, {
        title: "Detalhamento - Liquidado",
        data: filteredData,
        metricField: "v_liquidado",
        metricLabel: "LIQUIDADO",
        headerColor: "bg-amber-700",
        textColor: "text-amber-700",
        rowBgColor: "bg-amber-50/30"
      }), /*#__PURE__*/React.createElement(SubTable, {
        title: "Detalhamento - Pago",
        data: filteredData,
        metricField: "v_pago",
        metricLabel: "PAGO",
        headerColor: "bg-emerald-800",
        textColor: "text-emerald-700",
        rowBgColor: ""
      }), /*#__PURE__*/React.createElement(SubTable, {
        title: "Detalhamento - Cancelado",
        data: filteredData,
        metricField: "v_cancelado",
        metricLabel: "CANCELADO",
        headerColor: "bg-red-800",
        textColor: "text-red-700",
        rowBgColor: "bg-red-50/30"
      }), /*#__PURE__*/React.createElement(SubTable, {
        title: "Detalhamento - Bloqueado",
        data: filteredData,
        metricField: "v_bloqueado",
        metricLabel: "BLOQUEADO",
        headerColor: "bg-orange-800",
        textColor: "text-orange-700",
        rowBgColor: ""
      }))) : null,
      charts: activePage === 2 ? /*#__PURE__*/React.createElement("div", {
        className: "max-w-[1600px] mx-auto space-y-8 mb-8"
      }, "                ", /*#__PURE__*/React.createElement("div", {
        className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200 mb-10"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-center mb-4 border-b border-slate-100 pb-2"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-xs font-black text-slate-800 uppercase"
      }, "Evolu\xE7\xE3o Acumulada de Lan\xE7amentos"), /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-2"
      }, /*#__PURE__*/React.createElement("select", {
        className: "text-[10px] font-bold border border-slate-300 rounded px-2 py-1 outline-none focus:border-blue-500 shadow-sm cursor-pointer text-slate-700 bg-slate-50 uppercase",
        value: areaAggLevel,
        onChange: e => setAreaAggLevel(e.target.value)
      }, /*#__PURE__*/React.createElement("option", {
        value: "dia"
      }, "Por Dia"), /*#__PURE__*/React.createElement("option", {
        value: "mes"
      }, "Por M\xEAs/Ano"), /*#__PURE__*/React.createElement("option", {
        value: "ano"
      }, "Por Ano")), /*#__PURE__*/React.createElement("select", {
        className: "text-[10px] font-bold border border-slate-300 rounded px-2 py-1 outline-none focus:border-blue-500 shadow-sm cursor-pointer text-slate-700 bg-slate-50",
        value: areaXAxisMode,
        onChange: e => setAreaXAxisMode(e.target.value)
      }, /*#__PURE__*/React.createElement("option", {
        value: "normalizada"
      }, "Escala Normalizada"), /*#__PURE__*/React.createElement("option", {
        value: "nao_normalizada"
      }, "Escala N\xE3o Normalizada")))), /*#__PURE__*/React.createElement("div", {
        className: "h-[450px]"
      }, /*#__PURE__*/React.createElement(ChartComponent, {
        id: "chartAreaEvolucao",
        type: "line",
        data: {
          labels: areaChartData.labels,
          datasets: [{
            label: 'EMPENHADO',
            data: areaChartData.d_emp,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.3)',
            fill: true,
            tension: 0,
            pointRadius: 2
          }, {
            label: 'RECEBIDO',
            data: areaChartData.d_rec,
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139, 92, 246, 0.3)',
            fill: true,
            tension: 0,
            pointRadius: 2
          }, {
            label: 'LIQUIDADO',
            data: areaChartData.d_liq,
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.3)',
            fill: true,
            tension: 0,
            pointRadius: 2
          }, {
            label: 'PAGO',
            data: areaChartData.d_pag,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.3)',
            fill: true,
            tension: 0,
            pointRadius: 2
          }, {
            label: 'CANCELADO',
            data: areaChartData.d_can,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.3)',
            fill: true,
            tension: 0,
            pointRadius: 2
          }, {
            label: 'BLOQUEADO',
            data: areaChartData.d_blo,
            borderColor: '#f97316',
            backgroundColor: 'rgba(249, 115, 22, 0.3)',
            fill: true,
            tension: 0,
            pointRadius: 2
          }, {
            label: 'A LIQUIDAR',
            data: areaChartData.d_aliq,
            borderColor: '#94a3b8',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0,
            pointRadius: 2,
            borderDash: [5, 5]
          }, {
            label: 'A PAGAR',
            data: areaChartData.d_apag,
            borderColor: '#475569',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0,
            pointRadius: 2,
            borderDash: [2, 2]
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false
          },
          plugins: {
            datalabels: {
              display: function (context) {
                if (context.dataset.label === 'A LIQUIDAR' || context.dataset.label === 'A PAGAR') return false;
                const data = context.dataset.data;
                const index = context.dataIndex;
                if (index === 0) return data[index] > 0;
                return data[index] > data[index - 1];
              },
              color: '#1e293b',
              align: 'top',
              anchor: 'end',
              offset: 2,
              font: {
                size: 9,
                weight: 'bold'
              },
              formatter: value => shortenNumber(value),
              textStrokeColor: '#ffffff',
              textStrokeWidth: 2
            },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.9)',
              titleFont: {
                size: 13,
                weight: 'bold'
              },
              bodyFont: {
                size: 11
              },
              callbacks: {
                label: function (context) {
                  const val = context.raw.y !== undefined ? context.raw.y : context.raw;
                  const idx = context.dataIndex;
                  const empVal = areaChartData.d_emp[idx];
                  let pct = "0,0%";
                  if (empVal > 0) {
                    pct = (val / empVal * 100).toFixed(1).replace('.', ',') + '%';
                  }
                  let lines = [context.dataset.label + ': ' + formatBRL(val) + (context.dataset.label === 'EMPENHADO' ? '' : ` (${pct})`)];
                  if (areaChartData.tooltips[context.datasetIndex]) {
                    const docsList = areaChartData.tooltips[context.datasetIndex][context.dataIndex] || [];
                    if (docsList.length > 0) {
                      lines.push(...docsList.slice(0, 10).map(d => '  • ' + d));
                      if (docsList.length > 10) lines.push(`  ... (+ ${docsList.length - 10} docs)`);
                    }
                  }
                  return lines;
                }
              }
            }
          },
          scales: {
            x: {
              ticks: {
                font: {
                  size: 10
                },
                maxRotation: 90,
                minRotation: 45,
                autoSkip: true,
                maxTicksLimit: 30
              }
            },
            y: {
              beginAtZero: true,
              ticks: {
                callback: v => shortenNumber(v)
              }
            }
          }
        }
      }))), /*#__PURE__*/React.createElement("div", {
        className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200 mb-10"
      }, /*#__PURE__*/React.createElement("div", {
        className: "flex justify-between items-center mb-4 border-b border-slate-100 pb-2"
      }, /*#__PURE__*/React.createElement("h3", {
        className: "text-xs font-black text-slate-800 uppercase"
      }, "EVOLU\xC7\xC3O N\xC3O ACUMULADA DE LAN\xC7AMENTOS"), /*#__PURE__*/React.createElement("div", {
        className: "flex items-center gap-2"
      }, /*#__PURE__*/React.createElement("select", {
        className: "text-[10px] font-bold border border-slate-300 rounded px-2 py-1 outline-none focus:border-blue-500 shadow-sm cursor-pointer text-slate-700 bg-slate-50 uppercase",
        value: barAggLevel,
        onChange: e => setBarAggLevel(e.target.value)
      }, /*#__PURE__*/React.createElement("option", {
        value: "dia"
      }, "Por Dia"), /*#__PURE__*/React.createElement("option", {
        value: "mes"
      }, "Por M\xEAs/Ano"), /*#__PURE__*/React.createElement("option", {
        value: "ano"
      }, "Por Ano")), /*#__PURE__*/React.createElement("select", {
        className: "text-[10px] font-bold border border-slate-300 rounded px-2 py-1 outline-none focus:border-blue-500 shadow-sm cursor-pointer text-slate-700 bg-slate-50",
        value: barXAxisMode,
        onChange: e => setBarXAxisMode(e.target.value)
      }, /*#__PURE__*/React.createElement("option", {
        value: "normalizada"
      }, "Escala Normalizada"), /*#__PURE__*/React.createElement("option", {
        value: "nao_normalizada"
      }, "Escala N\xE3o Normalizada")))), /*#__PURE__*/React.createElement("div", {
        className: "h-[450px]"
      }, /*#__PURE__*/React.createElement(ChartComponent, {
        id: "chartBarEvolucao",
        type: "bubble",
        data: {
          labels: barChartData.labels,
          datasets: [{
            label: 'EMPENHADO',
            data: barChartData.d_emp.map((v, i) => ({
              x: barChartData.labels[i],
              y: v,
              r: v === 0 ? 0 : Math.max(5, v / barChartData.max_val * 25)
            })),
            backgroundColor: 'rgba(59, 130, 246, 0.6)',
            borderColor: '#3b82f6',
            borderWidth: 1
          }, {
            label: 'RECEBIDO',
            data: barChartData.d_rec.map((v, i) => ({
              x: barChartData.labels[i],
              y: v,
              r: v === 0 ? 0 : Math.max(5, v / barChartData.max_val * 25)
            })),
            backgroundColor: 'rgba(139, 92, 246, 0.6)',
            borderColor: '#8b5cf6',
            borderWidth: 1
          }, {
            label: 'LIQUIDADO',
            data: barChartData.d_liq.map((v, i) => ({
              x: barChartData.labels[i],
              y: v,
              r: v === 0 ? 0 : Math.max(5, v / barChartData.max_val * 25)
            })),
            backgroundColor: 'rgba(245, 158, 11, 0.6)',
            borderColor: '#f59e0b',
            borderWidth: 1
          }, {
            label: 'PAGO',
            data: barChartData.d_pag.map((v, i) => ({
              x: barChartData.labels[i],
              y: v,
              r: v === 0 ? 0 : Math.max(5, v / barChartData.max_val * 25)
            })),
            backgroundColor: 'rgba(16, 185, 129, 0.6)',
            borderColor: '#10b981',
            borderWidth: 1
          }, {
            label: 'CANCELADO',
            data: barChartData.d_can.map((v, i) => ({
              x: barChartData.labels[i],
              y: v,
              r: v === 0 ? 0 : Math.max(5, v / barChartData.max_val * 25)
            })),
            backgroundColor: 'rgba(239, 68, 68, 0.6)',
            borderColor: '#ef4444',
            borderWidth: 1
          }, {
            label: 'BLOQUEADO',
            data: barChartData.d_blo.map((v, i) => ({
              x: barChartData.labels[i],
              y: v,
              r: v === 0 ? 0 : Math.max(5, v / barChartData.max_val * 25)
            })),
            backgroundColor: 'rgba(249, 115, 22, 0.6)',
            borderColor: '#f97316',
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            datalabels: {
              display: false
            },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.9)',
              titleFont: {
                size: 13,
                weight: 'bold'
              },
              bodyFont: {
                size: 11
              },
              callbacks: {
                title: function (context) {
                  return context[0].raw.x;
                },
                label: function (context) {
                  const val = context.raw.y !== undefined ? context.raw.y : context.raw;
                  let lines = [context.dataset.label + ': ' + formatBRL(val)];
                  const docsList = barChartData.tooltips[context.datasetIndex][context.dataIndex] || [];
                  if (docsList.length > 0) {
                    lines.push(...docsList.slice(0, 10).map(d => '  • ' + d));
                    if (docsList.length > 10) lines.push(`  ... (+ ${docsList.length - 10} docs)`);
                  }
                  return lines;
                }
              }
            }
          },
          scales: {
            x: {
              type: 'category',
              labels: barChartData.labels,
              offset: true,
              ticks: {
                font: {
                  size: 10
                },
                maxRotation: 90,
                minRotation: 45,
                autoSkip: true,
                maxTicksLimit: 30
              }
            },
            y: {
              beginAtZero: true,
              ticks: {
                callback: v => shortenNumber(v)
              }
            }
          }
        }
      })))) : null
    };
  }
  return {
    useDashboard
  };
})(exportTable, ChartComponent);

// 6. NAVEGAÇÃO E PAINEL — estados de filtro, índices da carga e agregações memorizadas.
const DashboardPages = Object.freeze([{
  id: 1,
  label: 'PÁGINA 1',
  detail: 'Estatísticas'
}, {
  id: 2,
  label: 'PÁGINA 2',
  detail: 'Gráficos'
}, {
  id: 3,
  label: 'PÁGINA 3',
  detail: 'Tabelas'
}, {
  id: 4,
  label: 'PÁGINA 4',
  detail: 'Panorama dos documentos'
}, {
  id: 5,
  label: 'PÁGINA 5',
  detail: 'Tabelas dos documentos'
}]);
function PageNavigation(_ref53) {
  let {
    activePage,
    onPageChange
  } = _ref53;
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef(null),
    panelRef = useRef(null);
  const current = DashboardPages.find(page => page.id === activePage) || DashboardPages[0];
  const close = React.useCallback(() => setIsOpen(false), []);
  useEffect(() => {
    if (!isOpen || !panelRef.current) return;
    const panel = panelRef.current,
      returnTarget = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(panel.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
    (panel.querySelector('[aria-current="page"]') || focusable()[0] || panel).focus();
    const keydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable(),
        first = controls[0],
        last = controls[controls.length - 1];
      if (!first) {
        event.preventDefault();
        panel.focus();
        return;
      }
      if (!panel.contains(document.activeElement) || !event.shiftKey && document.activeElement === last || event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = previousOverflow;
      const target = returnTarget !== null && returnTarget !== void 0 && returnTarget.isConnected ? returnTarget : triggerRef.current;
      target === null || target === void 0 || target.focus();
    };
  }, [isOpen, close]);
  const selectPage = page => {
    onPageChange(page.id);
    close();
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    ref: triggerRef,
    type: "button",
    onClick: () => setIsOpen(true),
    "aria-expanded": isOpen,
    "aria-controls": "dashboard-page-navigation",
    "aria-haspopup": "dialog",
    "aria-label": `Abrir menu de páginas. Página atual: ${current.label}, ${current.detail}`,
    title: "Abrir menu de p\xE1ginas",
    className: "fixed right-3 top-3 z-40 inline-flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-xl border border-blue-700 bg-blue-700 px-4 py-3 text-white shadow-lg transition hover:bg-blue-800 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500 sm:right-4 sm:top-4"
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    className: "text-lg leading-none"
  }, "\u2630"), /*#__PURE__*/React.createElement("span", {
    className: "text-xs font-black tracking-wider"
  }, "P\xC1GINAS")), /*#__PURE__*/React.createElement("div", {
    hidden: !isOpen,
    className: "fixed inset-0 z-[80] bg-slate-950/50",
    onMouseDown: event => {
      if (event.target === event.currentTarget) close();
    }
  }, /*#__PURE__*/React.createElement("section", {
    id: "dashboard-page-navigation",
    ref: panelRef,
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "dashboard-page-navigation-title",
    "aria-describedby": "dashboard-page-navigation-help",
    tabIndex: -1,
    className: "absolute inset-y-0 left-0 flex max-h-screen flex-col border-r border-slate-200 bg-white shadow-2xl",
    style: {
      width: 'min(22rem, calc(100vw - 1rem))',
      height: '100dvh'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 p-5"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
    id: "dashboard-page-navigation-title",
    className: "text-base font-black text-slate-800"
  }, "Navegar pelas p\xE1ginas"), /*#__PURE__*/React.createElement("p", {
    id: "dashboard-page-navigation-help",
    className: "mt-1 text-xs text-slate-500"
  }, "Escolha uma p\xE1gina. Esc fecha este menu.")), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: close,
    "aria-label": "Fechar menu de p\xE1ginas",
    className: "rounded-lg px-3 py-2 text-lg font-bold text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
  }, "\xD7")), /*#__PURE__*/React.createElement("nav", {
    className: "min-h-0 flex-1 overflow-y-auto p-4",
    "aria-label": "P\xE1ginas do dashboard"
  }, /*#__PURE__*/React.createElement("ul", {
    className: "flex flex-col gap-2"
  }, DashboardPages.map(page => /*#__PURE__*/React.createElement("li", {
    key: page.id
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => selectPage(page),
    className: `w-full rounded-xl border px-4 py-4 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${activePage === page.id ? 'border-blue-700 bg-blue-700 text-white shadow-md' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`,
    "aria-current": activePage === page.id ? 'page' : undefined
  }, /*#__PURE__*/React.createElement("span", {
    className: "block text-[11px] font-black tracking-widest"
  }, page.label), /*#__PURE__*/React.createElement("span", {
    className: `mt-1 block text-xs font-bold ${activePage === page.id ? 'text-blue-100' : 'text-slate-500'}`
  }, page.detail)))))))), /*#__PURE__*/React.createElement("span", {
    className: "sr-only",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true"
  }, current.label, ": ", current.detail));
}
function Dashboard() {
  const [rawData, setRawData] = useState([]);
  const [apiPayload, setApiPayload] = useState(null);
  const [linkDiagnostics, setLinkDiagnostics] = useState(null);
  const missingFileColumns = useMemo(() => ContractFiles.missingColumns(apiPayload === null || apiPayload === void 0 ? void 0 : apiPayload.geral), [apiPayload]);
  const [resetRevision, setResetRevision] = useState(0);
  const loadingRef = useRef(false);
  const [summaryRequested, setSummaryRequested] = useState(() => sessionStorage.getItem('summary_pending_TotalV6') === '1');
  const closeSummary = React.useCallback(() => {
    sessionStorage.removeItem('summary_pending_TotalV6');
    setSummaryRequested(false);
  }, []);
  const [activePage, setActivePage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("A verificar sessão local...");
  const currentUser = sessionStorage.getItem('user_TotalV6') || 'Usuário';
  const currentPerfil = sessionStorage.getItem('perfil_TotalV6') || '';

  // Estado de Expansão Global das seções
  const [globalExpandState, setGlobalExpandState] = useState(false);
  const [expandTrigger, setExpandTrigger] = useState(0);
  const toggleAllSections = () => {
    const next = !globalExpandState;
    setGlobalExpandState(next);
    setExpandTrigger(prev => prev + 1);
  };
  const [sortConfig, setSortConfig] = useState({
    key: 'v_empenhado',
    direction: 'desc'
  });
  const [top20Sort, setTop20Sort] = useState('emp_desc');
  const [top20ViewMode, setTop20ViewMode] = useState('fornecedor');
  const [top20100Sort, setTop20100Sort] = useState('emp_desc');
  const [top20100ViewMode, setTop20100ViewMode] = useState('fornecedor');
  const [gestorChartSort, setGestorChartSort] = useState('emp_tit');
  const [fiscalChartSort, setFiscalChartSort] = useState('emp_tit');
  const [chartTableViews, setChartTableViews] = useState({
    gestor: false,
    fiscal: false,
    top20: false,
    top20100: false,
    ano: false,
    contrato: false,
    correlacao: false
  });
  const [fornecedorSort, setFornecedorSort] = useState('valor_desc');
  const [contratoSort, setContratoSort] = useState('dias_asc');
  const [scatterXAxis, setScatterXAxis] = useState('p_recebido');
  const [scatterHiddenTags, setScatterHiddenTags] = useState([]);
  const toggleChartTableView = key => setChartTableViews(previous => ({
    ...previous,
    [key]: !previous[key]
  }));

  // Novos Estados de Filtros
  const [fFiscal, setFFiscal] = useState([]);
  const [fGestor, setFGestor] = useState([]);
  const [fFiscalSub, setFFiscalSub] = useState([]);
  const [fGestorSub, setFGestorSub] = useState([]);
  const [fSecLog, setFSecLog] = useState(["SGLS-CLASSE I", "SGLFE-CLASSE II", "SGLC-CLASSE III", "SGLME-CLASSE V (MUN)"]);
  const [fContrato, setFContrato] = useState([]);
  const [fCompra, setFCompra] = useState([]);
  const [fModalidade, setFModalidade] = useState([]);
  const [fFornecedor, setFFornecedor] = useState([]);
  const [fAo, setFAo] = useState([]);
  const [fPo, setFPo] = useState([]);
  const [fPtres, setFPtres] = useState([]);
  const [fPi, setFPi] = useState([]);
  const [fNd, setFNd] = useState([]);
  const [fAoCodigo, setFAoCodigo] = useState([]);
  const [fAoNome, setFAoNome] = useState([]);
  const [fPoCodigo, setFPoCodigo] = useState([]);
  const [fPoNome, setFPoNome] = useState([]);
  const [fPiCod, setFPiCod] = useState([]);
  const [fPiNome, setFPiNome] = useState([]);
  const [fNdCodigo, setFNdCodigo] = useState([]);
  const [fNdNome, setFNdNome] = useState([]);
  const [fGrupo, setFGrupo] = useState([]);
  const [fNdModalidade, setFNdModalidade] = useState([]);
  const [fElemento, setFElemento] = useState([]);
  const [fSubelemento, setFSubelemento] = useState([]);
  const [dInicDe, setDInicDe] = useState("");
  const [dInicAte, setDInicAte] = useState("");
  const [dFimDe, setDFimDe] = useState("");
  const [dFimAte, setDFimAte] = useState("");
  const [searchContrato, setSearchContrato] = useState("");
  const [searchSituacao, setSearchSituacao] = useState("");
  const [searchSecLog, setSearchSecLog] = useState("");
  const [searchFornecedor, setSearchFornecedor] = useState("");
  const [searchObjeto, setSearchObjeto] = useState("");
  const [searchGestorFiscal, setSearchGestorFiscal] = useState("");
  const [searchAo, setSearchAo] = useState("");
  const [searchPo, setSearchPo] = useState("");
  const [searchNd, setSearchNd] = useState("");
  const [showMasterColsMenu, setShowMasterColsMenu] = useState(false);
  const [expandedBudgetDimensions, setExpandedBudgetDimensions] = useState({});
  const financeTableRef = useRef(null);
  const masterColumnLabels = {
    contrato: "CONTRATO/COMPRA",
    arquivos: "ARQUIVOS",
    situacao: "SITUAÇÃO",
    secLog: "SEC LOG",
    fornecedor: "FORNECEDOR",
    objeto: "OBJETO",
    gestorFiscal: "GESTORES/FISCAIS",
    dataInic: "INÍCIO",
    dataFim: "FIM",
    percTempo: "% TEMPO",
    diasPassaram: "PASSARAM",
    encerrandoDias: "FALTAM",
    ao: "AO",
    po: "PO",
    nd: "ND",
    difGlobal: "GLOBAL-EMP",
    vGlobal: "GLOBAL",
    empenhado: "EMPENHADO",
    recebido: "RECEBIDO",
    pRecebido: "RCB %",
    liquidado: "LIQUIDADO",
    pLiquidado: "LIQ %",
    aLiquidar: "A LIQUIDAR",
    pALiquidar: "A LIQ %",
    pago: "PAGO",
    pPago: "PAGO %",
    aPagar: "A PAGAR",
    pAPagar: "A PAGAR %",
    bloqueado: "BLOQUEADO",
    pBloqueado: "BLOQ %",
    cancelado: "CANCELADO",
    pCancelado: "CANC %",
    executado: "EXECUTADO",
    pExecutado: "EXEC %",
    execLiq: "EXEC LIQ",
    pExecLiq: "EXEC LIQ %"
  };
  const [masterVisibleCols, setMasterVisibleCols] = useState({
    contrato: true,
    arquivos: true,
    situacao: true,
    secLog: true,
    fornecedor: true,
    objeto: true,
    gestorFiscal: true,
    ao: true,
    po: true,
    nd: true,
    dataInic: true,
    dataFim: true,
    percTempo: true,
    diasPassaram: true,
    encerrandoDias: true,
    difGlobal: true,
    vGlobal: true,
    empenhado: true,
    recebido: true,
    pRecebido: true,
    liquidado: true,
    pLiquidado: true,
    aLiquidar: true,
    pALiquidar: true,
    pago: true,
    pPago: true,
    aPagar: true,
    pAPagar: true,
    bloqueado: true,
    pBloqueado: true,
    cancelado: true,
    pCancelado: true,
    executado: true,
    pExecutado: true,
    execLiq: true,
    pExecLiq: true
  });
  const initialNumFilters = {
    perc_tempo: {
      min: '',
      max: ''
    },
    dias_passaram: {
      min: '',
      max: ''
    },
    encerrando_dias: {
      min: '',
      max: ''
    },
    dif_global: {
      min: '',
      max: ''
    },
    v_global: {
      min: '',
      max: ''
    },
    v_empenhado: {
      min: '',
      max: ''
    },
    v_recebido: {
      min: '',
      max: ''
    },
    p_recebido: {
      min: '',
      max: ''
    },
    v_liquidado: {
      min: '',
      max: ''
    },
    p_liquidado: {
      min: '',
      max: ''
    },
    v_a_liquidar: {
      min: '',
      max: ''
    },
    p_a_liquidar: {
      min: '',
      max: ''
    },
    v_pago: {
      min: '',
      max: ''
    },
    p_pago: {
      min: '',
      max: ''
    },
    v_a_pagar: {
      min: '',
      max: ''
    },
    p_a_pagar: {
      min: '',
      max: ''
    },
    v_bloqueado: {
      min: '',
      max: ''
    },
    p_bloqueado: {
      min: '',
      max: ''
    },
    v_cancelado: {
      min: '',
      max: ''
    },
    p_cancelado: {
      min: '',
      max: ''
    },
    v_executado: {
      min: '',
      max: ''
    },
    p_executado: {
      min: '',
      max: ''
    }
  };
  const [numFilters, setNumFilters] = useState(initialNumFilters);
  const initialDateFilters = {
    data_inic: {
      min: '',
      max: ''
    },
    data_fim: {
      min: '',
      max: ''
    }
  };
  const [dateFilters, setDateFilters] = useState(initialDateFilters);
  const toggleBudgetDimension = (contract, dimension) => {
    setExpandedBudgetDimensions(previous => {
      const current = previous[contract] || [];
      const next = current.includes(dimension) ? current.filter(item => item !== dimension) : [...current, dimension];
      next.sort((a, b) => ['ao', 'po', 'nd'].indexOf(a) - ['ao', 'po', 'nd'].indexOf(b));
      const updated = {
        ...previous
      };
      if (next.length) updated[contract] = next;else delete updated[contract];
      return updated;
    });
  };

  // TAGs System para Ações Rápidas
  const [fSituacaoTags, setFSituacaoTags] = useState([]);
  const toggleSituacaoTag = lbl => {
    setFSituacaoTags(prev => prev.includes(lbl) ? prev.filter(x => x !== lbl) : [...prev, lbl]);
  };
  const toggleScatterTag = tag => {
    setScatterHiddenTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };
  const handleSort = key => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
  };
  const clearAllFilters = () => {
    setResetRevision(value => value + 1);
    setFAoCodigo([]);
    setFAoNome([]);
    setFPoCodigo([]);
    setFPoNome([]);
    setFPiCod([]);
    setFPiNome([]);
    setFNdCodigo([]);
    setFNdNome([]);
    setFGrupo([]);
    setFNdModalidade([]);
    setFElemento([]);
    setFSubelemento([]);
    setFFiscal([]);
    setFGestor([]);
    setFFiscalSub([]);
    setFGestorSub([]);
    setFSecLog([]);
    setFContrato([]);
    setFCompra([]);
    setFModalidade([]);
    setFFornecedor([]);
    setFAo([]);
    setFPo([]);
    setFPtres([]);
    setFPi([]);
    setFNd([]);
    setDInicDe("");
    setDInicAte("");
    setDFimDe("");
    setDFimAte("");
    setSearchContrato("");
    setSearchSituacao("");
    setSearchSecLog("");
    setSearchFornecedor("");
    setSearchObjeto("");
    setSearchGestorFiscal("");
    setSearchAo("");
    setSearchPo("");
    setSearchNd("");
    setFSituacaoTags([]);
    setNumFilters(initialNumFilters);
    setDateFilters(initialDateFilters);
  };
  const getOffsetDateStr = offsetDays => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const todayStr = getOffsetDateStr(0);
  const sevenDaysAgoStr = getOffsetDateStr(-7);
  const thirtyDaysAgoStr = getOffsetDateStr(-30);
  const sevenDaysAheadStr = getOffsetDateStr(7);
  const thirtyDaysAheadStr = getOffsetDateStr(30);
  const isVigentesActive = !dInicDe && dInicAte === todayStr && dFimDe === todayStr && !dFimAte;
  const isVencendo7Active = !dInicDe && !dInicAte && dFimDe === todayStr && dFimAte === sevenDaysAheadStr;
  const isVencendo30Active = !dInicDe && !dInicAte && dFimDe === todayStr && dFimAte === thirtyDaysAheadStr;
  const isSevenActive = !dInicDe && !dInicAte && dFimDe === sevenDaysAgoStr && !dFimAte;
  const isThirtyActive = !dInicDe && !dInicAte && dFimDe === thirtyDaysAgoStr && !dFimAte;
  const isVencidos7Active = !dInicDe && !dInicAte && dFimDe === sevenDaysAgoStr && dFimAte === todayStr;
  const isVencidos30Active = !dInicDe && !dInicAte && dFimDe === thirtyDaysAgoStr && dFimAte === todayStr;
  const clearQuickDateFilters = () => {
    setDInicDe("");
    setDInicAte("");
    setDFimDe("");
    setDFimAte("");
  };
  const toggleVigentes = () => {
    if (isVigentesActive) clearQuickDateFilters();else {
      setDInicDe("");
      setDInicAte(todayStr);
      setDFimDe(todayStr);
      setDFimAte("");
    }
  };
  const toggleVencendo7 = () => {
    if (isVencendo7Active) clearQuickDateFilters();else {
      setDInicDe("");
      setDInicAte("");
      setDFimDe(todayStr);
      setDFimAte(sevenDaysAheadStr);
    }
  };
  const toggleVencendo30 = () => {
    if (isVencendo30Active) clearQuickDateFilters();else {
      setDInicDe("");
      setDInicAte("");
      setDFimDe(todayStr);
      setDFimAte(thirtyDaysAheadStr);
    }
  };
  const toggleSevenDays = () => {
    if (isSevenActive) clearQuickDateFilters();else {
      setDInicDe("");
      setDInicAte("");
      setDFimDe(sevenDaysAgoStr);
      setDFimAte("");
    }
  };
  const toggleThirtyDays = () => {
    if (isThirtyActive) clearQuickDateFilters();else {
      setDInicDe("");
      setDInicAte("");
      setDFimDe(thirtyDaysAgoStr);
      setDFimAte("");
    }
  };
  const toggleVencidos7 = () => {
    if (isVencidos7Active) clearQuickDateFilters();else {
      setDInicDe("");
      setDInicAte("");
      setDFimDe(sevenDaysAgoStr);
      setDFimAte(todayStr);
    }
  };
  const toggleVencidos30 = () => {
    if (isVencidos30Active) clearQuickDateFilters();else {
      setDInicDe("");
      setDInicAte("");
      setDFimDe(thirtyDaysAgoStr);
      setDFimAte(todayStr);
    }
  };
  const cSupItems = ["SGLS-CLASSE I", "SGLFE-CLASSE II", "SGLC-CLASSE III", "SGLME-CLASSE V (MUN)"];
  const isCSupActive = fSecLog.length === 4 && cSupItems.every(i => fSecLog.includes(i));
  const toggleCSup = () => {
    if (isCSupActive) setFSecLog([]);else setFSecLog(cSupItems);
  };
  const nonCSupItems = [...new Set(rawData.map(item => item.sec_log).filter(value => value && value !== '-' && !cSupItems.includes(value)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const isNonCSupActive = nonCSupItems.length > 0 && fSecLog.length === nonCSupItems.length && nonCSupItems.every(item => fSecLog.includes(item));
  const toggleNonCSup = () => {
    if (isNonCSupActive) setFSecLog([]);else setFSecLog(nonCSupItems);
  };
  const showCOLOG = () => setFSecLog([]);
  const logout = () => {
    clearAuthStorage();
    try {
      localStorage.removeItem(DASH_CACHE_KEY);
      localStorage.removeItem('dashData_TotalV6');
    } catch (e) {}
    window.location.reload();
  };
  const sharedFilters = useMemo(() => ({
    fContrato,
    fFiscal,
    fGestor,
    fFiscalSub,
    fGestorSub,
    fSecLog,
    fCompra,
    fModalidade,
    fSituacaoTags,
    fAoCodigo,
    fAoNome,
    fPoCodigo,
    fPoNome,
    fPtres,
    fPiCod,
    fPiNome,
    fNdCodigo,
    fNdNome,
    fGrupo,
    fNdModalidade,
    fElemento,
    fSubelemento,
    dInicDe,
    dInicAte,
    dFimDe,
    dFimAte,
    fFornecedor,
    fAo,
    fPo,
    fPi,
    fNd
  }), [fContrato, fFiscal, fGestor, fFiscalSub, fGestorSub, fSecLog, fCompra, fModalidade, fSituacaoTags, fAoCodigo, fAoNome, fPoCodigo, fPoNome, fPtres, fPiCod, fPiNome, fNdCodigo, fNdNome, fGrupo, fNdModalidade, fElemento, fSubelemento, dInicDe, dInicAte, dFimDe, dFimAte, fFornecedor, fAo, fPo, fPi, fNd]);
  const documentDashboard = DocumentModule.useDashboard({
    payload: apiPayload,
    shared: sharedFilters,
    rawContracts: rawData,
    activePage,
    globalExpandState,
    expandTrigger,
    resetRevision
  });
  const normalizeDocumentKey = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const buildOrcamentarioByContrato = function (orcamentarioRows) {
    let recebidoByDocumento = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
    const result = {};
    if (!orcamentarioRows || orcamentarioRows.length < 2) return result;
    const headers = orcamentarioRows[0] || [];
    const headerMap = {};
    headers.forEach((header, index) => {
      const normalized = normalizeStr(header);
      if (normalized) headerMap[normalized] = index;
    });
    const getValue = function (row, exactNames) {
      let fallbackKeywords = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : [];
      for (const name of exactNames) {
        const index = headerMap[normalizeStr(name)];
        if (index !== undefined && row[index] !== undefined && row[index] !== null) {
          return row[index].toString().trim();
        }
      }
      for (const keyword of fallbackKeywords) {
        const normalizedKeyword = normalizeStr(keyword);
        const headerKey = Object.keys(headerMap).find(key => key.includes(normalizedKeyword));
        if (headerKey) {
          const value = row[headerMap[headerKey]];
          return value !== undefined && value !== null ? value.toString().trim() : '';
        }
      }
      return '';
    };
    const createAccumulator = () => ({
      ao_codigo_values: new Set(),
      ao_nome_values: new Set(),
      ao_filter_values: new Set(),
      po_codigo_values: new Set(),
      po_nome_values: new Set(),
      po_filter_values: new Set(),
      ptres_values: new Set(),
      pi_cod_values: new Set(),
      pi_nome_values: new Set(),
      pi_filter_values: new Set(),
      nd_codigo_values: new Set(),
      nd_nome_values: new Set(),
      nd_filter_values: new Set(),
      orc_detail_rows: new Map()
    });
    const addValue = (accumulator, key, value) => {
      const normalizedValue = (value || '').toString().trim().toUpperCase();
      if (normalizedValue && normalizedValue !== '-') accumulator[key].add(normalizedValue);
    };
    const addNameCodePair = (accumulator, key, name, code) => {
      const normalizedName = (name || '').toString().trim().toUpperCase();
      const normalizedCode = (code || '').toString().trim().toUpperCase();
      if ((!normalizedName || normalizedName === '-') && (!normalizedCode || normalizedCode === '-')) return;
      const codeFirst = key === 'ao_filter_values' || key === 'po_filter_values';
      const pairCode = normalizedCode && normalizedCode !== '-' ? normalizedCode : 'N/I';
      accumulator[key].add(normalizedName && normalizedName !== '-' ? codeFirst ? `${pairCode} – ${normalizedName}` : `${normalizedName} – ${pairCode}` : normalizedCode);
    };
    const normalizeDimension = value => {
      const normalized = String(value || '').trim().toUpperCase();
      return normalized && normalized !== '-' ? normalized : 'N/I';
    };
    orcamentarioRows.slice(1).forEach(row => {
      if (!row || !row.length) return;
      const contrato = getValue(row, ['COL_NR_CONTR_BASE', 'Contrato', 'Número Contrato', 'Numero Contrato'], ['contr base', 'contrato']).toUpperCase();
      if (!contrato || contrato === '-') return;
      if (!result[contrato]) result[contrato] = createAccumulator();
      const target = result[contrato];
      const aoCodigo = getValue(row, ['Ação Governo Código', 'AO Código', 'AO Codigo'], ['acao governo codigo']);
      const aoNome = getValue(row, ['Ação Governo Nome', 'AO Nome'], ['acao governo nome']);
      const poCodigo = getValue(row, ['Plano Orçamentário Código PO', 'PO Código', 'PO Codigo'], ['plano orcamentario codigo po']);
      const poNome = getValue(row, ['Plano Orçamentário Nome', 'PO Nome'], ['plano orcamentario nome']);
      const piCodigo = getValue(row, ['PI Código PI', 'PI Código', 'PI Codigo'], ['pi codigo pi']);
      const piNome = getValue(row, ['PI Nome'], ['pi nome']);
      const ndCodigo = getValue(row, ['ND_DOC', 'ND Código', 'ND Codigo'], ['nd doc']);
      const ndNome = getValue(row, ['ND_NOME', 'ND Nome'], ['nd nome']);
      const ndRecords = UnifiedData.ndParts({
        nd_codigo: ndCodigo,
        nd_nome: ndNome
      });
      const ndCodigoValues = ndRecords.map(part => part.code);
      const ndNomeValues = ndRecords.map(part => part.name);
      const ptres = getValue(row, ['PTRES Código', 'PTRES Codigo', 'PTRES'], ['ptres codigo', 'ptres']);
      const documento = getValue(row, ['Documento CCor Número', 'Documento CCor Numero', 'DOCUMENTO_CCOR_NUMERO'], ['documento ccor']);
      addValue(target, 'ao_codigo_values', aoCodigo);
      addValue(target, 'ao_nome_values', aoNome);
      addNameCodePair(target, 'ao_filter_values', aoNome, aoCodigo);
      addValue(target, 'po_codigo_values', poCodigo);
      addValue(target, 'po_nome_values', poNome);
      addNameCodePair(target, 'po_filter_values', poNome, poCodigo);
      addValue(target, 'ptres_values', ptres);
      addValue(target, 'pi_cod_values', piCodigo);
      addValue(target, 'pi_nome_values', piNome);
      addNameCodePair(target, 'pi_filter_values', piNome, piCodigo);
      ndCodigoValues.forEach(code => addValue(target, 'nd_codigo_values', code));
      ndNomeValues.forEach(name => addValue(target, 'nd_nome_values', name));
      ndCodigoValues.forEach((code, index) => addNameCodePair(target, 'nd_filter_values', ndNomeValues[index] || (ndNomeValues.length === 1 ? ndNomeValues[0] : ''), code));
      const documentKey = `${normalizeContractKey(contrato)}|${normalizeDocumentKey(documento)}`;
      const detail = {
        contrato,
        documento: normalizeDimension(documento),
        ug: getValue(row, ['Emitente - UG Código', 'Emitente - UG Codigo', 'UG Emitente', 'UG Código', 'UG Codigo']),
        ao_codigo: normalizeDimension(aoCodigo),
        ao_nome: normalizeDimension(aoNome),
        po_codigo: normalizeDimension(poCodigo),
        po_nome: normalizeDimension(poNome),
        pi_codigo: normalizeDimension(piCodigo),
        pi_nome: normalizeDimension(piNome),
        nd_codigo: normalizeDimension(ndCodigoValues.join('; ')),
        nd_nome: normalizeDimension(ndNomeValues.join('; ')),
        ptres: normalizeDimension(ptres),
        v_empenhado: parseValue(getValue(row, ['TOTAL EMPENHADO'], ['total empenhado'])),
        v_liquidado: parseValue(getValue(row, ['TOTAL LIQUIDADO'], ['total liquidado'])),
        v_pago: parseValue(getValue(row, ['TOTAL PAGO'], ['total pago'])),
        v_cancelado: parseValue(getValue(row, ['TOTAL CANCELADO'], ['total cancelado'])),
        v_bloqueado: parseValue(getValue(row, ['TOTAL BLOQUEADO'], ['total bloqueado'])),
        v_recebido: recebidoByDocumento[documentKey] || 0
      };
      detail.ao_filter = detail.ao_nome !== 'N/I' ? `${detail.ao_codigo} – ${detail.ao_nome}` : detail.ao_codigo;
      detail.po_filter = detail.po_nome !== 'N/I' ? `${detail.po_codigo} – ${detail.po_nome}` : detail.po_codigo;
      detail.pi_filter = detail.pi_nome !== 'N/I' ? `${detail.pi_nome} – ${detail.pi_codigo}` : detail.pi_codigo;
      detail.nd_filter_values = ndCodigoValues.map((code, index) => {
        const name = ndNomeValues[index] || (ndNomeValues.length === 1 ? ndNomeValues[0] : '');
        return name ? `${name} – ${code}` : code;
      });
      detail.nd_filter = detail.nd_filter_values.join('; ') || detail.nd_codigo;
      detail.v_a_liquidar = detail.v_empenhado - detail.v_liquidado - detail.v_cancelado - detail.v_bloqueado;
      detail.v_a_pagar = detail.v_empenhado - detail.v_pago - detail.v_cancelado - detail.v_bloqueado;
      detail.v_executado = detail.v_liquidado + detail.v_cancelado + detail.v_bloqueado;
      const detailKey = [documentKey, UnifiedData.key(detail.ug), detail.ao_codigo, detail.ao_nome, detail.po_codigo, detail.po_nome, detail.pi_codigo, detail.pi_nome, detail.ptres, detail.nd_codigo, detail.nd_nome].join('|');
      const previous = target.orc_detail_rows.get(detailKey);
      if (!previous) target.orc_detail_rows.set(detailKey, detail);else {
        ['v_empenhado', 'v_liquidado', 'v_pago', 'v_cancelado', 'v_bloqueado', 'v_recebido', 'v_a_liquidar', 'v_a_pagar', 'v_executado'].forEach(metric => {
          previous[metric] += detail[metric] || 0;
        });
      }
    });
    Object.values(result).forEach(accumulator => {
      UnifiedData.attachReceived([...accumulator.orc_detail_rows.values()], recebidoByDocumento);
      Object.keys(accumulator).forEach(key => {
        if (accumulator[key] instanceof Set) {
          accumulator[key] = [...accumulator[key]].sort((a, b) => a.localeCompare(b, 'pt-BR', {
            numeric: true
          }));
        } else if (accumulator[key] instanceof Map) {
          accumulator[key] = [...accumulator[key].values()].sort((a, b) => [a.ao_codigo, a.po_codigo, a.nd_codigo, a.pi_codigo].join('|').localeCompare([b.ao_codigo, b.po_codigo, b.nd_codigo, b.pi_codigo].join('|'), 'pt-BR', {
            numeric: true
          }));
        }
      });
    });
    return result;
  };
  const emptyOrcamentario = () => ({
    ao_codigo_values: [],
    ao_nome_values: [],
    ao_filter_values: [],
    po_codigo_values: [],
    po_nome_values: [],
    po_filter_values: [],
    ptres_values: [],
    pi_cod_values: [],
    pi_nome_values: [],
    pi_filter_values: [],
    nd_codigo_values: [],
    nd_nome_values: [],
    nd_filter_values: [],
    orc_detail_rows: []
  });
  const normalizeContractKey = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const buildRecebidoByDocumento = contabilRows => {
    const recebidoByDocumento = {};
    if (!contabilRows || contabilRows.length < 2) return recebidoByDocumento;
    const headers = contabilRows[0] || [];
    const headerMap = {};
    headers.forEach((header, index) => {
      const normalized = normalizeStr(header);
      if (normalized) headerMap[normalized] = index;
    });
    const getValue = function (row, exactNames) {
      let fallbackKeywords = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : [];
      for (const name of exactNames) {
        const index = headerMap[normalizeStr(name)];
        if (index !== undefined && row[index] !== undefined && row[index] !== null) return row[index].toString().trim();
      }
      for (const keyword of fallbackKeywords) {
        const normalizedKeyword = normalizeStr(keyword);
        const headerKey = Object.keys(headerMap).find(key => key.includes(normalizedKeyword));
        if (headerKey) return String(row[headerMap[headerKey]] || '').trim();
      }
      return '';
    };
    contabilRows.slice(1).forEach(row => {
      if (!row || !row.length) return;
      const information = getValue(row, ['ITEM_INFORMACAO', 'INTEN_INFORMACAO', 'Informação', 'Informacao'], ['item informacao', 'informacao']);
      if (!normalizeStr(information).includes('recebido')) return;
      const documentKey = normalizeContractKey(getValue(row, ["COL_NR_CONTR_BASE", "Contrato", "Número Contrato"], ["contrato"])) + "|" + normalizeDocumentKey(getValue(row, ['Documento CCor Número', 'Documento CCor Numero', 'DOCUMENTO_CCOR_NUMERO'], ['documento ccor']));
      if (documentKey.endsWith('|') || documentKey.startsWith('|')) return;
      const rawValue = getValue(row, ['Valor Item (R$)', 'Valor (R$)', 'VALOR', 'Valor'], ['valor item', 'valor']);
      recebidoByDocumento[documentKey] = (recebidoByDocumento[documentKey] || 0) + parseValue(rawValue);
    });
    return recebidoByDocumento;
  };
  const processData = function (rowsArray) {
    let contabilRows = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
    let orcamentarioRows = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : [];
    let fromCache = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : false;
    if (!rowsArray || rowsArray.length < 1) {
      setStatus("Planilha vazia ou aba não encontrada.");
      setLoading(false);
      return;
    }
    const ledgerIndex = ContractRules.accountingBalances(contabilRows);
    setApiPayload({
      geral: rowsArray,
      contabil: contabilRows,
      orcamentario: orcamentarioRows,
      ledgerIndex
    });
    setStatus("A estruturar matriz de dados...");
    const headers = rowsArray[0];
    const filesByContract = ContractFiles.index(rowsArray);
    const normalizedHeaders = headers.map(normalizeStr);
    const headerIndices = new Map(normalizedHeaders.map((value, index) => [value, index]));
    const recebidoByContrato = Object.fromEntries([...ledgerIndex].map(_ref54 => {
      let [contract, totals] = _ref54;
      return [contract, totals.v_recebido];
    }));
    const receivedAssigned = new Set();
    const recebidoByDocumento = buildRecebidoByDocumento(contabilRows);
    const orcamentarioByContrato = buildOrcamentarioByContrato(orcamentarioRows, recebidoByDocumento);
    const findBudgetContract = UnifiedData.contractLookup(orcamentarioByContrato);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const uniqueRows = new Map(rowsArray.slice(1).map(row => [JSON.stringify(row), row]));
    const mappedRaw = [...uniqueRows.values()].map(row => {
      const getVal = function (exactNames) {
        let fallbackKeywords = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];
        let nameArr = Array.isArray(exactNames) ? exactNames : [exactNames];
        for (let name of nameArr) {
          const normName = normalizeStr(name);
          const idx = headerIndices.has(normName) ? headerIndices.get(normName) : -1;
          if (idx !== -1 && row[idx] !== undefined && row[idx] !== null) return row[idx].toString().trim();
        }
        for (let kw of fallbackKeywords) {
          const normKw = normalizeStr(kw);
          const idx = normalizedHeaders.findIndex(h => h.includes(normKw));
          if (idx !== -1 && row[idx] !== undefined && row[idx] !== null) return row[idx].toString().trim();
        }
        return "";
      };
      const dtInicParsed = parseDateBR(getVal(["Vig. Início", "Vigencia Inicio"]));
      const dtFimParsed = parseDateBR(getVal(["Vig. Fim", "Vigencia Fim"]));
      let diasRestantes = null,
        diasPassaram = null,
        percTempo = null,
        duracaoTotalDias = null;
      if (dtFimParsed) diasRestantes = Math.ceil((dtFimParsed - hoje) / 86400000);
      if (dtInicParsed) diasPassaram = Math.ceil((hoje - dtInicParsed) / 86400000);
      if (dtInicParsed && dtFimParsed) {
        duracaoTotalDias = Math.ceil((dtFimParsed - dtInicParsed) / 86400000);
        percTempo = duracaoTotalDias > 0 ? diasPassaram / duracaoTotalDias : 0;
      }
      const v_empenhado = parseValue(getVal(["TOTAL EMPENHADO"]));
      const v_liquidado = parseValue(getVal(["TOTAL LIQUIDADO"]));
      const v_pago = parseValue(getVal(["TOTAL PAGO"]));
      const v_cancelado = parseValue(getVal(["TOTAL CANCELADO"]));
      const v_bloqueado = parseValue(getVal(["TOTAL BLOQUEADO"]));
      const contrato = (getVal(["Número Contrato", "numero_contrato", "COL_NR_CONTR_BASE"]) || "-").toUpperCase();
      const receivedKey = normalizeContractKey(contrato);
      const v_recebido = receivedAssigned.has(receivedKey) ? 0 : recebidoByContrato[receivedKey] || 0;
      receivedAssigned.add(receivedKey);
      const orcamentario = findBudgetContract(contrato) || emptyOrcamentario();
      const v_a_liquidar = v_empenhado - v_liquidado - v_cancelado - v_bloqueado;
      const v_a_pagar = v_empenhado - v_pago - v_cancelado - v_bloqueado;
      const p_a_liquidar = v_empenhado ? v_a_liquidar / v_empenhado : 0;
      const p_a_pagar = v_empenhado ? v_a_pagar / v_empenhado : 0;
      const p_recebido = v_empenhado ? v_recebido / v_empenhado : 0;
      return {
        contrato,
        files: filesByContract.get(UnifiedData.key(contrato)) || ContractFiles.empty,
        ...orcamentario,
        ao_codigos: orcamentario.ao_codigo_values.join('; ') || '-',
        po_codigos: orcamentario.po_codigo_values.join('; ') || '-',
        nd_codigos: orcamentario.nd_codigo_values.join('; ') || '-',
        fornecedor: (getVal(["Fornecedor"]) || "N/I").toUpperCase(),
        objeto: (getVal(["Objeto"]) || "-").toUpperCase(),
        fiscal: (getVal(["FISCAL_TITULAR", "Fiscal Titular"]) || "N/I").toUpperCase(),
        gestor: (getVal(["GESTOR_TITULAR", "Gestor Titular"]) || "N/I").toUpperCase(),
        fiscal_sub: (getVal(["FISCAL_SUBSTITUTO", "Fiscal Substituto"]) || "N/I").toUpperCase(),
        gestor_sub: (getVal(["GESTOR_SUBSTITUTO", "Gestor Substituto"]) || "N/I").toUpperCase(),
        sec_log: (getVal(["SEC_LOG"]) || "N/I").toUpperCase(),
        modalidade: (getVal(["Modalidade da Compra", "Modalidade"]) || "N/I").toUpperCase(),
        compra: (getVal(["Número da Compra", "Numero da Compra", "Número Compra", "Numero Compra"]) || "N/I").toUpperCase(),
        data_inic: getVal(["Vig. Início", "Vigencia Inicio"]),
        data_fim: getVal(["Vig. Fim", "Vigencia Fim"]),
        dtInicVal: dtInicParsed ? dtInicParsed.getTime() : 0,
        dtFimVal: dtFimParsed ? dtFimParsed.getTime() : 0,
        ano_vig_ini: dtInicParsed ? dtInicParsed.getFullYear().toString() : "N/I",
        dias_passaram: diasPassaram,
        perc_tempo: percTempo,
        encerrando_dias: diasRestantes,
        duracao_total_dias: duracaoTotalDias,
        v_global: parseValue(getVal(["Valor Global"])),
        v_empenhado,
        v_recebido,
        p_recebido,
        v_liquidado,
        v_pago,
        v_bloqueado,
        v_cancelado,
        v_executado: parseValue(getVal(["TOTAL EXECUTADO"])),
        v_a_liquidar,
        p_a_liquidar,
        v_a_pagar,
        p_a_pagar,
        p_liquidado: parsePercentAsFloat(getVal(["TOTAL LIQUIDADO %"])),
        p_pago: parsePercentAsFloat(getVal(["TOTAL PAGO %"])),
        p_bloqueado: parsePercentAsFloat(getVal(["TOTAL BLOQUEADO %"])),
        p_cancelado: parsePercentAsFloat(getVal(["TOTAL CANCELADO %"])),
        p_executado: parsePercentAsFloat(getVal(["TOTAL EXECUTADO %"]))
      };
    }).filter(r => r.contrato !== "-");
    const canonicalIndex = ContractRules.contractIndex(mappedRaw);
    const canonicalClassifications = new Map([...canonicalIndex].map(_ref55 => {
      var _ledgerIndex$get;
      let [id, entry] = _ref55;
      return [id, ContractRules.classify(entry.totals, entry.metadata, (_ledgerIndex$get = ledgerIndex.get(id)) === null || _ledgerIndex$get === void 0 ? void 0 : _ledgerIndex$get.hasMovement, hoje)];
    }));

    // Árvore de Decisão de TAGS
    mappedRaw.forEach(r => {
      const canonicalKey = UnifiedData.key(r.contrato);
      const entry = canonicalIndex.get(canonicalKey);
      const c = entry.totals;
      r.contract_metadata = entry.metadata;
      r.contract_metadata_conflicts = [...entry.conflicts];
      r.contrato_empenhado_total = c.v_empenhado;
      r.dif_global = r.v_global - r.v_empenhado;
      const classification = canonicalClassifications.get(canonicalKey);
      const flags = classification.labels.map(label => ({
        label,
        color: tagColorsMap[label].css,
        hex: tagColorsMap[label].hex
      }));
      const sitText = classification.labels.join(' ');
      r.situacao_principal = classification.primary;
      r.situacaoFlags = flags;
      r.situacao = sitText.trim() || 'N/I';
    });
    setRawData(mappedRaw);
    setLoading(false);
  };
  const loadData = async function () {
    let forceSync = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;
    let manualFileContent = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    if (manualFileContent) {
      Papa.parse(manualFileContent, {
        header: false,
        skipEmptyLines: true,
        complete: res => {
          processData(res.data, [], [], true);
          loadingRef.current = false;
          setStatus("Offline - CSV Local (sem recebido contábil e classificação orçamentária)");
        }
      });
      return;
    }
    try {
      setStatus("A transferir dados via Api...");
      const token = sessionStorage.getItem('token_TotalV6');
      if (!token) throw new Error("Token de acesso não encontrado. Faça login novamente.");
      const response = await fetch(`${APPS_SCRIPT_URL}?acao=dados&token=${encodeURIComponent(token)}`);
      const json = await readAppsScriptJson(response, 'a sincronização dos dados');
      if (!json.ok) {
        const mensagem = json.mensagem || "Falha ao obter dados pelo Apps Script.";
        if (/sess[aã]o|expirad|token/i.test(mensagem)) {
          clearAuthStorage();
          try {
            localStorage.removeItem(DASH_CACHE_KEY);
          } catch (e) {}
          window.location.reload();
          return;
        }
        throw new Error(mensagem);
      }
      const rows = json.geral || json.values;
      if (!rows || rows.length < 1) throw new Error("Apps Script não retornou dados da planilha geral.");
      processData(rows, json.contabil || [], json.orcamentario || [], false);
      setLinkDiagnostics(json.diagnosticoOrcamentario || null);
      const controle = json.controleAcesso || {};
      setStatus(`Online - Dados carregados via Api | ${ContractRules.accessText(controle)}`);
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Falha de acesso à API. Tente sincronizar novamente.");
      setLoading(false);
    } finally {
      loadingRef.current = false;
    }
  };
  useEffect(() => {
    loadData(false, null);
  }, []);
  const filterOptions = useMemo(() => {
    const scalarFields = ['fiscal', 'gestor', 'fiscal_sub', 'gestor_sub', 'sec_log', 'contrato', 'compra', 'modalidade', 'fornecedor'];
    const arrayFields = ['ao_filter_values', 'po_filter_values', 'ptres_values', 'pi_filter_values', 'nd_filter_values', 'ao_codigo_values', 'ao_nome_values', 'po_codigo_values', 'po_nome_values', 'pi_cod_values', 'pi_nome_values', 'nd_codigo_values', 'nd_nome_values', 'nd_grupo_values', 'nd_modalidade_values', 'nd_elemento_values', 'nd_subelemento_filter_values'];
    const accumulators = {};
    [...scalarFields, ...arrayFields].forEach(field => {
      accumulators[field] = new Set();
    });
    rawData.forEach(item => {
      scalarFields.forEach(field => {
        const value = item[field];
        if (value && value !== '-') accumulators[field].add(value);
      });
      arrayFields.forEach(field => {
        (Array.isArray(item[field]) ? item[field] : []).forEach(value => {
          if (value && value !== '-') accumulators[field].add(value);
        });
      });
    });
    scalarFields.forEach(field => {
      if (field !== 'fornecedor') (documentDashboard.options[field] || []).forEach(value => {
        if (value && value !== '-') accumulators[field].add(value);
      });
    });
    const budgetOptionsMap = {
      ao_filter_values: 'ao_filter',
      po_filter_values: 'po_filter',
      pi_filter_values: 'pi_filter',
      nd_filter_values: 'nd_filter_values',
      ao_codigo_values: 'ao_codigo',
      ao_nome_values: 'ao_nome',
      po_codigo_values: 'po_codigo',
      po_nome_values: 'po_nome',
      ptres_values: 'ptres',
      pi_cod_values: 'pi_codigo',
      pi_nome_values: 'pi_nome',
      nd_codigo_values: 'nd_codigo',
      nd_nome_values: 'nd_nome',
      nd_grupo_values: 'nd_grupo_values',
      nd_modalidade_values: 'nd_modalidade_values',
      nd_elemento_values: 'nd_elemento_values',
      nd_subelemento_filter_values: 'nd_subelemento_filter_values'
    };
    documentDashboard.budgetIndex.byContract.forEach(details => details.forEach(detail => {
      Object.entries(budgetOptionsMap).forEach(_ref56 => {
        let [field, property] = _ref56;
        const values = Array.isArray(detail[property]) ? detail[property] : splitBudgetDimensionValue(detail[property]);
        values.forEach(value => {
          if (value && value !== '-' && value !== 'N/I') accumulators[field].add(value);
        });
      });
    }));
    const options = {};
    Object.keys(accumulators).forEach(field => {
      options[field] = [...accumulators[field]].sort((a, b) => a.localeCompare(b, 'pt-BR', {
        numeric: true
      }));
    });
    return options;
  }, [rawData, documentDashboard.options, documentDashboard.budgetIndex]);
  const filteredData = useMemo(() => {
    const filterDateBounds = {
      startFrom: dInicDe ? new Date(dInicDe + 'T00:00:00').getTime() : null,
      startUntil: dInicAte ? new Date(dInicAte + 'T23:59:59').getTime() : null,
      endFrom: dFimDe ? new Date(dFimDe + 'T00:00:00').getTime() : null,
      endUntil: dFimAte ? new Date(dFimAte + 'T23:59:59').getTime() : null,
      columnStartFrom: dateFilters.data_inic.min ? new Date(dateFilters.data_inic.min + 'T00:00:00').getTime() : null,
      columnStartUntil: dateFilters.data_inic.max ? new Date(dateFilters.data_inic.max + 'T23:59:59').getTime() : null,
      columnEndFrom: dateFilters.data_fim.min ? new Date(dateFilters.data_fim.min + 'T00:00:00').getTime() : null,
      columnEndUntil: dateFilters.data_fim.max ? new Date(dateFilters.data_fim.max + 'T23:59:59').getTime() : null
    };
    const budgetFilterActive = UnifiedData.hasBudgetFilters(sharedFilters);
    let filtered = rawData.filter(item => {
      const mFisc = fFiscal.length === 0 || fFiscal.includes(item.fiscal);
      const mGest = fGestor.length === 0 || fGestor.includes(item.gestor);
      const mFiscSub = fFiscalSub.length === 0 || fFiscalSub.includes(item.fiscal_sub);
      const mGestSub = fGestorSub.length === 0 || fGestorSub.includes(item.gestor_sub);
      const mSec = fSecLog.length === 0 || fSecLog.includes(item.sec_log);
      const mCont = fContrato.length === 0 || fContrato.includes(item.contrato);
      const mForn = fFornecedor.length === 0 || fFornecedor.includes(item.fornecedor);
      const mCompra = fCompra.length === 0 || fCompra.includes(item.compra);
      const mMod = fModalidade.length === 0 || fModalidade.includes(item.modalidade);
      const matchesOrcamentario = (selected, field) => selected.length === 0 || selected.some(value => (Array.isArray(item[field]) ? item[field] : []).includes(value));
      const mAo = matchesOrcamentario(fAo, 'ao_filter_values');
      const mPo = matchesOrcamentario(fPo, 'po_filter_values');
      const mPtres = matchesOrcamentario(fPtres, 'ptres_values');
      const mPi = matchesOrcamentario(fPi, 'pi_filter_values');
      const mNd = matchesOrcamentario(fNd, 'nd_filter_values');
      const mDDe = !dInicDe || item.dtInicVal && item.dtInicVal >= filterDateBounds.startFrom;
      const mDAte = !dInicAte || item.dtInicVal && item.dtInicVal <= filterDateBounds.startUntil;
      const mFDe = !dFimDe || item.dtFimVal && item.dtFimVal >= filterDateBounds.endFrom;
      const mFAte = !dFimAte || item.dtFimVal && item.dtFimVal <= filterDateBounds.endUntil;
      let mDateTbl = true;
      if (dateFilters.data_inic.min && item.dtInicVal < filterDateBounds.columnStartFrom) mDateTbl = false;
      if (dateFilters.data_inic.max && item.dtInicVal > filterDateBounds.columnStartUntil) mDateTbl = false;
      if (dateFilters.data_fim.min && item.dtFimVal < filterDateBounds.columnEndFrom) mDateTbl = false;
      if (dateFilters.data_fim.max && item.dtFimVal > filterDateBounds.columnEndUntil) mDateTbl = false;
      const sCont = !searchContrato || item.contrato.includes(searchContrato.toUpperCase()) || item.compra.includes(searchContrato.toUpperCase()) || item.modalidade.includes(searchContrato.toUpperCase());
      const sSit = !searchSituacao || item.situacao.includes(searchSituacao.toUpperCase());
      const sSecLog = !searchSecLog || item.sec_log.includes(searchSecLog.toUpperCase());
      const sForn = !searchFornecedor || item.fornecedor.includes(searchFornecedor.toUpperCase());
      const sObj = !searchObjeto || item.objeto.includes(searchObjeto.toUpperCase());
      const sGest = !searchGestorFiscal || item.gestor.includes(searchGestorFiscal.toUpperCase()) || item.fiscal.includes(searchGestorFiscal.toUpperCase());
      const sAo = !searchAo || String(item.ao_codigos || '').includes(searchAo.toUpperCase()) || (item.ao_filter_values || []).some(value => value.includes(searchAo.toUpperCase()));
      const sPo = !searchPo || String(item.po_codigos || '').includes(searchPo.toUpperCase()) || (item.po_filter_values || []).some(value => value.includes(searchPo.toUpperCase()));
      const sNd = !searchNd || String(item.nd_codigos || '').includes(searchNd.toUpperCase()) || (item.nd_filter_values || []).some(value => value.includes(searchNd.toUpperCase()));
      const mSitTag = fSituacaoTags.length === 0 || item.situacaoFlags.some(f => fSituacaoTags.includes(f.label));
      let mNum = true;
      for (const key in numFilters) {
        if (numFilters[key].min !== '' && (key.startsWith('p_') ? item[key] * 100 : item[key]) < parseFloat(numFilters[key].min)) {
          mNum = false;
          break;
        }
        if (numFilters[key].max !== '' && (key.startsWith('p_') ? item[key] * 100 : item[key]) > parseFloat(numFilters[key].max)) {
          mNum = false;
          break;
        }
      }
      const mDocuments = !documentDashboard.contractKeys || documentDashboard.contractKeys.has(normalizeContractKey(item.contrato));
      const mBudget = !budgetFilterActive || (item.orc_detail_rows || []).some(detail => UnifiedData.matchesBudgetDetail(detail, sharedFilters));
      return mDocuments && mBudget && mFisc && mGest && mFiscSub && mGestSub && mSec && mCont && mForn && mCompra && mMod && mAo && mPo && mPtres && mPi && mNd && mDDe && mDAte && mFDe && mFAte && mDateTbl && sCont && sSit && sSecLog && sForn && sObj && sGest && sAo && sPo && sNd && mSitTag && mNum;
    });
    if (sortConfig.key) {
      filtered.sort((a, b) => {
        let valA = a[sortConfig.key],
          valB = b[sortConfig.key];
        if (sortConfig.key === 'data_inic') {
          valA = a.dtInicVal;
          valB = b.dtInicVal;
        } else if (sortConfig.key === 'data_fim') {
          valA = a.dtFimVal;
          valB = b.dtFimVal;
        } else if (['encerrando_dias', 'dias_passaram', 'perc_tempo'].includes(sortConfig.key)) {
          valA = valA !== null ? valA : -999999;
          valB = valB !== null ? valB : -999999;
        }
        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return filtered;
  }, [rawData, documentDashboard.contractKeys, sharedFilters, fFiscal, fGestor, fFiscalSub, fGestorSub, fSecLog, fContrato, fFornecedor, fCompra, fModalidade, fAo, fPo, fPtres, fPi, fNd, dInicDe, dInicAte, dFimDe, dFimAte, dateFilters, searchContrato, searchSituacao, searchSecLog, searchFornecedor, searchObjeto, searchGestorFiscal, searchAo, searchPo, searchNd, numFilters, sortConfig, fSituacaoTags]);
  const filteredOrcamentarioDetails = useMemo(() => {
    const details = [];
    const processedContracts = new Set();
    filteredData.forEach(item => {
      if (processedContracts.has(UnifiedData.key(item.contrato))) return;
      processedContracts.add(UnifiedData.key(item.contrato));
      (item.orc_detail_rows || []).forEach(detail => {
        UnifiedData.budgetDetailPortions(detail, sharedFilters).forEach(portion => details.push({
          ...portion,
          contrato: item.contrato
        }));
      });
    });
    return details;
  }, [filteredData, sharedFilters, fAo, fPo, fPtres, fPi, fNd]);
  const receivedWithoutClassification = useMemo(() => {
    const values = new Map();
    filteredOrcamentarioDetails.forEach(detail => {
      if (detail.recebido_sem_classificacao) values.set(`${UnifiedData.key(detail.contrato)}|${UnifiedData.key(detail.documento)}`, detail.recebido_sem_classificacao);
    });
    return [...values.values()].reduce((sum, value) => sum + value, 0);
  }, [filteredOrcamentarioDetails]);
  const budgetBreakdownByContract = useMemo(() => {
    const byContract = {};
    filteredOrcamentarioDetails.forEach(detail => {
      if (!byContract[detail.contrato]) byContract[detail.contrato] = {};
      const ndCodes = splitBudgetDimensionValue(detail.nd_codigo);
      const ndNames = splitBudgetDimensionValue(detail.nd_nome);
      const normalizedCodes = ndCodes.length ? ndCodes : ['N/I'];
      const allocation = 1 / normalizedCodes.length;
      normalizedCodes.forEach((ndCode, index) => {
        const ndName = ndNames[index] || (ndNames.length === 1 ? ndNames[0] : 'N/I');
        const key = [detail.ao_codigo, detail.po_codigo, ndCode].join('|');
        if (!byContract[detail.contrato][key]) {
          byContract[detail.contrato][key] = {
            ao_codigo: detail.ao_codigo,
            ao_nome: detail.ao_nome,
            po_codigo: detail.po_codigo,
            po_nome: detail.po_nome,
            nd_codigo: ndCode,
            nd_nome: ndName,
            v_empenhado: 0,
            v_recebido: 0,
            v_liquidado: 0,
            v_a_liquidar: 0,
            v_pago: 0,
            v_a_pagar: 0,
            v_bloqueado: 0,
            v_cancelado: 0,
            v_executado: 0
          };
        }
        const target = byContract[detail.contrato][key];
        ['v_empenhado', 'v_recebido', 'v_liquidado', 'v_a_liquidar', 'v_pago', 'v_a_pagar', 'v_bloqueado', 'v_cancelado', 'v_executado'].forEach(metric => {
          target[metric] += (detail[metric] || 0) * allocation;
        });
      });
    });
    Object.keys(byContract).forEach(contract => {
      byContract[contract] = Object.values(byContract[contract]).map(item => ({
        ...item,
        p_recebido: item.v_empenhado ? item.v_recebido / item.v_empenhado : 0,
        p_liquidado: item.v_empenhado ? item.v_liquidado / item.v_empenhado : 0,
        p_a_liquidar: item.v_empenhado ? item.v_a_liquidar / item.v_empenhado : 0,
        p_pago: item.v_empenhado ? item.v_pago / item.v_empenhado : 0,
        p_a_pagar: item.v_empenhado ? item.v_a_pagar / item.v_empenhado : 0,
        p_bloqueado: item.v_empenhado ? item.v_bloqueado / item.v_empenhado : 0,
        p_cancelado: item.v_empenhado ? item.v_cancelado / item.v_empenhado : 0,
        p_executado: item.v_empenhado ? item.v_executado / item.v_empenhado : 0,
        p_exec_liq: item.v_empenhado ? item.v_pago / item.v_empenhado : 0
      }));
    });
    return byContract;
  }, [filteredOrcamentarioDetails]);
  const getSelectedBudgetDetails = (contract, dimensions) => {
    if (!(dimensions !== null && dimensions !== void 0 && dimensions.length)) return [];
    const grouped = {};
    const metricKeys = ['v_empenhado', 'v_recebido', 'v_liquidado', 'v_a_liquidar', 'v_pago', 'v_a_pagar', 'v_bloqueado', 'v_cancelado', 'v_executado'];
    (budgetBreakdownByContract[contract] || []).forEach(detail => {
      const key = dimensions.map(dimension => detail[`${dimension}_codigo`] || 'N/I').join('|');
      if (!grouped[key]) {
        grouped[key] = {
          ao_codigo: dimensions.includes('ao') ? detail.ao_codigo : '',
          ao_nome: dimensions.includes('ao') ? detail.ao_nome : '',
          po_codigo: dimensions.includes('po') ? detail.po_codigo : '',
          po_nome: dimensions.includes('po') ? detail.po_nome : '',
          nd_codigo: dimensions.includes('nd') ? detail.nd_codigo : '',
          nd_nome: dimensions.includes('nd') ? detail.nd_nome : '',
          _dimensions: dimensions,
          ...Object.fromEntries(metricKeys.map(metric => [metric, 0]))
        };
      }
      metricKeys.forEach(metric => {
        grouped[key][metric] += detail[metric] || 0;
      });
    });
    return Object.values(grouped).map(item => ({
      ...item,
      p_recebido: item.v_empenhado ? item.v_recebido / item.v_empenhado : 0,
      p_liquidado: item.v_empenhado ? item.v_liquidado / item.v_empenhado : 0,
      p_a_liquidar: item.v_empenhado ? item.v_a_liquidar / item.v_empenhado : 0,
      p_pago: item.v_empenhado ? item.v_pago / item.v_empenhado : 0,
      p_a_pagar: item.v_empenhado ? item.v_a_pagar / item.v_empenhado : 0,
      p_bloqueado: item.v_empenhado ? item.v_bloqueado / item.v_empenhado : 0,
      p_cancelado: item.v_empenhado ? item.v_cancelado / item.v_empenhado : 0,
      p_executado: item.v_empenhado ? item.v_executado / item.v_empenhado : 0,
      p_exec_liq: item.v_empenhado ? item.v_pago / item.v_empenhado : 0
    })).sort((a, b) => dimensions.map(dimension => a[`${dimension}_codigo`]).join('|').localeCompare(dimensions.map(dimension => b[`${dimension}_codigo`]).join('|'), 'pt-BR'));
  };

  // Autofit real das colunas de INÍCIO até a última métrica visível.
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      const table = financeTableRef.current;
      if (!table) return;
      const metricHeaders = Array.from(table.querySelectorAll('thead th:not(.master-text-col)'));
      metricHeaders.forEach(header => {
        if (header.dataset.userSized === 'true') return;
        const columnIndex = header.cellIndex;
        const cells = [header, ...Array.from(table.querySelectorAll('tbody tr:not(.budget-detail-row)')).map(row => Array.from(row.cells).find(cell => cell.cellIndex === columnIndex && cell.colSpan === 1)).filter(Boolean)];
        cells.forEach(cell => {
          cell.style.width = 'auto';
          cell.style.minWidth = '40px';
          cell.style.maxWidth = 'none';
          cell.style.whiteSpace = 'nowrap';
          cell.style.overflowWrap = 'normal';
        });
        const contentWidth = cells.reduce((maxWidth, cell) => Math.max(maxWidth, cell.scrollWidth + 6), 0);
        const fittedWidth = Math.max(72, contentWidth);
        cells.forEach(cell => {
          cell.style.width = `${fittedWidth}px`;
          cell.style.minWidth = '40px';
        });
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [filteredData, masterVisibleCols, expandedBudgetDimensions]);
  const totalsMaster = useMemo(() => {
    let global = 0,
      dif = 0,
      emp = 0,
      rec = 0,
      liq = 0,
      pag = 0,
      blo = 0,
      can = 0,
      exe = 0,
      a_liq = 0,
      a_pag = 0;
    filteredData.forEach(r => {
      global += r.v_global;
      dif += r.dif_global;
      emp += r.v_empenhado;
      rec += r.v_recebido || 0;
      liq += r.v_liquidado;
      pag += r.v_pago;
      blo += r.v_bloqueado;
      can += r.v_cancelado;
      exe += r.v_executado;
      a_liq += r.v_a_liquidar;
      a_pag += r.v_a_pagar;
    });
    return {
      global,
      dif,
      emp,
      rec,
      liq,
      pag,
      blo,
      can,
      exe,
      a_liq,
      a_pag,
      p_rec: emp ? rec / emp : 0
    };
  }, [filteredData]);
  const kpis = useMemo(() => {
    let global = 0,
      emp = 0,
      rec = 0,
      liq = 0,
      pag = 0,
      blo = 0,
      can = 0,
      exe = 0;
    const processedContracts = new Set();
    let qtdAtivos = 0,
      qtdAtivosInexec = 0,
      qtdAtivosEmExec = 0,
      qtdAtivosExecTot = 0,
      qtdAtivosExecParc = 0;
    let qtdVencidos = 0,
      qtdVencInexecTot = 0,
      qtdVencidosTot = 0,
      qtdVencidosParc = 0;
    let qtdBloqueados = 0,
      qtdCancelados = 0;
    filteredData.forEach(r => {
      global += r.v_global;
      emp += r.v_empenhado;
      rec += r.v_recebido || 0;
      liq += r.v_liquidado;
      pag += r.v_pago;
      blo += r.v_bloqueado;
      can += r.v_cancelado;
      exe += r.v_executado;
      if (!processedContracts.has(UnifiedData.key(r.contrato))) {
        processedContracts.add(UnifiedData.key(r.contrato));
        if (r.situacaoFlags.some(f => f.label === 'CAN')) qtdCancelados++;
        if (r.situacaoFlags.some(f => f.label === 'BLOQ')) qtdBloqueados++;
        if (ContractRules.phase(r) === 'vigente') {
          qtdAtivos++;
          if (r.situacaoFlags.some(f => f.label === 'VIG SEM EXEC')) qtdAtivosInexec++;
          if (r.situacaoFlags.some(f => f.label === 'VIG EM EXEC')) qtdAtivosEmExec++;
          if (r.situacaoFlags.some(f => f.label === 'VIG EXEC TOTAL')) qtdAtivosExecTot++;
          if (r.situacaoFlags.some(f => f.label === 'VIG EXEC PARCIAL')) qtdAtivosExecParc++;
        } else if (ContractRules.phase(r) === 'vencido') {
          qtdVencidos++;
          if (r.situacaoFlags.some(f => f.label === 'VENC INEXEC TOTAL')) qtdVencInexecTot++;
          if (r.situacaoFlags.some(f => f.label === 'VENC EXEC TOTAL')) qtdVencidosTot++;
          if (r.situacaoFlags.some(f => f.label === 'VENC EXEC PARCIAL')) qtdVencidosParc++;
        }
      }
    });
    const validName = v => v && v !== '-' && v !== 'N/I';
    const gestoresTitulares = new Set(filteredData.map(d => d.gestor).filter(validName));
    const gestoresSubstitutos = new Set(filteredData.map(d => d.gestor_sub).filter(validName));
    const gestoresTodos = new Set([...gestoresTitulares, ...gestoresSubstitutos]);
    const fiscaisTitulares = new Set(filteredData.map(d => d.fiscal).filter(validName));
    const fiscaisSubstitutos = new Set(filteredData.map(d => d.fiscal_sub).filter(validName));
    const fiscaisTodos = new Set([...fiscaisTitulares, ...fiscaisSubstitutos]);
    return {
      qtdContratos: processedContracts.size,
      qtdGestores: gestoresTodos.size,
      qtdGestoresTit: gestoresTitulares.size,
      qtdGestoresSub: gestoresSubstitutos.size,
      qtdFiscais: fiscaisTodos.size,
      qtdFiscaisTit: fiscaisTitulares.size,
      qtdFiscaisSub: fiscaisSubstitutos.size,
      qtdFornecedores: new Set(filteredData.map(d => d.fornecedor).filter(validName)).size,
      qtdSecLog: new Set(filteredData.map(d => d.sec_log).filter(validName)).size,
      qtdAtivos,
      qtdAtivosInexec,
      qtdAtivosEmExec,
      qtdAtivosExecTot,
      qtdAtivosExecParc,
      qtdVencidos,
      qtdVencInexecTot,
      qtdVencidosTot,
      qtdVencidosParc,
      qtdBloqueados,
      qtdCancelados,
      global,
      emp,
      rec,
      liq,
      pag,
      blo,
      can,
      exe,
      pEmpGlobal: global ? emp / global : 0,
      pRec: emp ? rec / emp : 0,
      pLiq: emp ? liq / emp : 0,
      pPag: emp ? pag / emp : 0,
      pBlo: emp ? blo / emp : 0,
      pCan: emp ? can / emp : 0,
      pExe: emp ? exe / emp : 0
    };
  }, [filteredData]);
  const loginSummary = useMemo(() => apiPayload && documentDashboard.ready ? ContractRules.loginSummary(rawData, documentDashboard.rawRows) : null, [apiPayload, rawData, documentDashboard.ready, documentDashboard.rawRows]);
  const metadataConflictCount = useMemo(() => new Set(rawData.filter(row => {
    var _row$contract_metadat;
    return (_row$contract_metadat = row.contract_metadata_conflicts) === null || _row$contract_metadat === void 0 ? void 0 : _row$contract_metadat.length;
  }).map(row => UnifiedData.key(row.contrato))).size, [rawData]);
  const getPersonData = (roleType, sortKey) => {
    const map = {};
    filteredData.forEach(item => {
      const tit = item[roleType];
      const sub = item[roleType + '_sub'];
      const emp = item.v_empenhado || 0;
      if (tit && tit !== '-' && tit !== 'N/I') {
        if (!map[tit]) map[tit] = {
          label: tit,
          emp_tit: 0,
          emp_sub: 0,
          qtd_tit: 0,
          qtd_sub: 0,
          contratos_tit: new Set(),
          contratos_sub: new Set(),
          total: 0
        };
        map[tit].emp_tit += emp;
        map[tit].contratos_tit.add(UnifiedData.key(item.contrato));
        map[tit].qtd_tit = map[tit].contratos_tit.size;
        map[tit].total += emp;
      }
      if (sub && sub !== '-' && sub !== 'N/I') {
        if (!map[sub]) map[sub] = {
          label: sub,
          emp_tit: 0,
          emp_sub: 0,
          qtd_tit: 0,
          qtd_sub: 0,
          contratos_tit: new Set(),
          contratos_sub: new Set(),
          total: 0
        };
        map[sub].emp_sub += emp;
        map[sub].contratos_sub.add(UnifiedData.key(item.contrato));
        map[sub].qtd_sub = map[sub].contratos_sub.size;
        map[sub].total += emp;
      }
    });
    const values = Object.values(map);
    if (sortKey === 'nome_asc') values.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));else values.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0) || a.label.localeCompare(b.label, 'pt-BR'));
    return values.slice(0, 10);
  };
  const gestorDataProcessed = getPersonData('gestor', gestorChartSort);
  const fiscalDataProcessed = getPersonData('fiscal', fiscalChartSort);
  const getPieDataFull = function (key) {
    let filterCustom = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
    const map = {};
    const dataToProcess = filterCustom ? filteredData.filter(filterCustom) : filteredData;
    dataToProcess.forEach(item => {
      const rawDimension = item[key];
      let val = Array.isArray(rawDimension) ? rawDimension.length ? rawDimension.join(' / ') : "N/I" : rawDimension && rawDimension !== "-" ? rawDimension : "N/I";
      if (key === 'situacao') {
        const mainTag = ContractRules.primaryFlag(item.situacaoFlags);
        val = mainTag ? mainTag.label : val;
      }
      if (!map[val]) map[val] = {
        label: val,
        contracts: new Set(),
        count: 0,
        total: 0,
        recebido: 0,
        a_receber: 0,
        liquidado: 0,
        a_liquidar: 0,
        pago: 0,
        a_pagar: 0,
        bloqueado: 0,
        cancelado: 0,
        executado: 0
      };
      map[val].contracts.add(UnifiedData.key(item.contrato));
      map[val].count = map[val].contracts.size;
      map[val].total += item.v_empenhado;
      map[val].recebido += item.v_recebido || 0;
      map[val].a_receber += (item.v_empenhado || 0) - (item.v_recebido || 0);
      map[val].liquidado += item.v_liquidado;
      map[val].a_liquidar += item.v_a_liquidar;
      map[val].pago += item.v_pago;
      map[val].a_pagar += item.v_a_pagar;
      map[val].bloqueado += item.v_bloqueado;
      map[val].cancelado += item.v_cancelado;
      map[val].executado += item.v_executado;
    });
    return Object.values(map);
  };
  const getOrcamentarioPieData = dimensionKey => {
    const map = {};
    filteredOrcamentarioDetails.forEach(detail => {
      const rawLabel = detail[dimensionKey] && detail[dimensionKey] !== '-' ? detail[dimensionKey] : 'N/I';
      const labels = dimensionKey === 'nd_codigo' ? splitBudgetDimensionValue(rawLabel) : [rawLabel];
      const nameKey = dimensionKey.replace('_codigo', '_nome');
      const rawName = detail[nameKey] && detail[nameKey] !== '-' ? detail[nameKey] : 'N/I';
      const names = dimensionKey === 'nd_codigo' ? splitBudgetDimensionValue(rawName) : [rawName];
      const normalizedLabels = labels.length ? labels : ['N/I'];
      const allocation = 1 / normalizedLabels.length;
      normalizedLabels.forEach((label, index) => {
        const dimensionName = names[index] || (names.length === 1 ? names[0] : 'N/I');
        if (!map[label]) map[label] = {
          label,
          contracts: new Set(),
          descriptions: new Set(),
          total: 0,
          recebido: 0,
          a_receber: 0,
          liquidado: 0,
          a_liquidar: 0,
          pago: 0,
          a_pagar: 0,
          bloqueado: 0,
          cancelado: 0,
          executado: 0
        };
        const target = map[label];
        target.contracts.add(UnifiedData.key(detail.contrato));
        target.descriptions.add(`${label} – ${dimensionName}`);
        target.total += (detail.v_empenhado || 0) * allocation;
        target.recebido += (detail.v_recebido || 0) * allocation;
        target.a_receber += ((detail.v_empenhado || 0) - (detail.v_recebido || 0)) * allocation;
        target.liquidado += (detail.v_liquidado || 0) * allocation;
        target.a_liquidar += (detail.v_a_liquidar || 0) * allocation;
        target.pago += (detail.v_pago || 0) * allocation;
        target.a_pagar += (detail.v_a_pagar || 0) * allocation;
        target.bloqueado += (detail.v_bloqueado || 0) * allocation;
        target.cancelado += (detail.v_cancelado || 0) * allocation;
        target.executado += (detail.v_executado || 0) * allocation;
      });
    });
    return Object.values(map).map(item => ({
      ...item,
      count: item.contracts.size,
      tooltip: Array.from(item.descriptions).join('\n')
    }));
  };
  const modData = getPieDataFull('modalidade');
  const secData = getPieDataFull('sec_log');
  const compraData = getPieDataFull('compra');
  const fornData = getPieDataFull('fornecedor');
  const anoVigIniData = getPieDataFull('ano_vig_ini');
  const aoCodigoData = getOrcamentarioPieData('ao_codigo');
  const ndCodigoData = getOrcamentarioPieData('nd_codigo');

  // Gráficos Situação restritos a apenas as 7 TAGS
  const allowedSitTags = ['VIG SEM EXEC', 'VIG EM EXEC', 'VIG EXEC TOTAL', 'VIG EXEC PARCIAL', 'VENC INEXEC TOTAL', 'VENC EXEC TOTAL', 'VENC EXEC PARCIAL'];
  const sitFilter = item => item.situacaoFlags.some(f => allowedSitTags.includes(f.label));
  const situacaoData = getPieDataFull('situacao', sitFilter);
  const getTop20Key = (item, mode) => {
    if (mode === 'contrato') return UnifiedData.key(item.contrato);
    if (mode === 'ano') return item.ano_vig_ini;
    if (mode === 'modalidade') return item.modalidade;
    if (mode === 'sec_log') return item.sec_log;
    return item.fornecedor;
  };
  const sortTop20Array = (arr, sortKey) => {
    const metricMap = {
      valor_desc: 'total',
      emp_desc: 'total',
      rec_desc: 'recebido',
      liq_desc: 'liquidado',
      pag_desc: 'pago',
      can_desc: 'cancelado',
      bloq_desc: 'bloqueado',
      aliq_desc: 'a_liquidar',
      apag_desc: 'a_pagar',
      pemp_desc: 'p_empenhado',
      prec_desc: 'p_recebido',
      pliq_desc: 'p_liquidado',
      ppag_desc: 'p_pago',
      pcan_desc: 'p_cancelado',
      pbloq_desc: 'p_bloqueado',
      paliq_desc: 'p_a_liquidar',
      papag_desc: 'p_a_pagar',
      qtd_desc: 'count'
    };
    if (sortKey === 'nome_asc') return arr.sort((a, b) => a.label.localeCompare(b.label));
    if (sortKey === 'nome_desc') return arr.sort((a, b) => b.label.localeCompare(a.label));
    const metric = metricMap[sortKey] || 'total';
    return arr.sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  };
  const renderTop20SortOptions = () => /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("option", {
    value: "emp_desc"
  }, "MAIOR EMPENHADO"), /*#__PURE__*/React.createElement("option", {
    value: "rec_desc"
  }, "MAIOR RECEBIDO"), /*#__PURE__*/React.createElement("option", {
    value: "liq_desc"
  }, "MAIOR LIQUIDADO"), /*#__PURE__*/React.createElement("option", {
    value: "pag_desc"
  }, "MAIOR PAGO"), /*#__PURE__*/React.createElement("option", {
    value: "can_desc"
  }, "MAIOR CANCELADO"), /*#__PURE__*/React.createElement("option", {
    value: "bloq_desc"
  }, "MAIOR BLOQUEADO"), /*#__PURE__*/React.createElement("option", {
    value: "aliq_desc"
  }, "MAIOR A LIQUIDAR"), /*#__PURE__*/React.createElement("option", {
    value: "apag_desc"
  }, "MAIOR A PAGAR"), /*#__PURE__*/React.createElement("option", {
    value: "pemp_desc"
  }, "MAIOR % EMPENHADO"), /*#__PURE__*/React.createElement("option", {
    value: "prec_desc"
  }, "MAIOR % RECEBIDO"), /*#__PURE__*/React.createElement("option", {
    value: "pliq_desc"
  }, "MAIOR % LIQUIDADO"), /*#__PURE__*/React.createElement("option", {
    value: "ppag_desc"
  }, "MAIOR % PAGO"), /*#__PURE__*/React.createElement("option", {
    value: "pcan_desc"
  }, "MAIOR % CANCELADO"), /*#__PURE__*/React.createElement("option", {
    value: "pbloq_desc"
  }, "MAIOR % BLOQUEADO"), /*#__PURE__*/React.createElement("option", {
    value: "paliq_desc"
  }, "MAIOR % A LIQUIDAR"), /*#__PURE__*/React.createElement("option", {
    value: "papag_desc"
  }, "MAIOR % A PAGAR"), /*#__PURE__*/React.createElement("option", {
    value: "qtd_desc"
  }, "MAIOR QTD"), /*#__PURE__*/React.createElement("option", {
    value: "nome_asc"
  }, "ORDEM A-Z"));
  const commitmentData = useMemo(() => {
    const knownContracts = new Set(rawData.map(row => UnifiedData.key(row.contrato)));
    const selectedContracts = new Set(filteredData.map(row => UnifiedData.key(row.contrato)));
    const rows = documentDashboard.filteredRows.filter(row => !knownContracts.has(UnifiedData.key(row.contrato)) || selectedContracts.has(UnifiedData.key(row.contrato)));
    return UnifiedData.aggregateCommitments(rows);
  }, [rawData, filteredData, documentDashboard.filteredRows]);
  const buildTop20Data = function (viewMode, sortKey) {
    let limit = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 20;
    const map = {};
    const budgetDimensionMap = {
      ao_codigo: 'ao_codigo',
      nd_codigo: 'nd_codigo',
      pi_codigo: 'pi_codigo'
    };
    const budgetDimensionKey = budgetDimensionMap[viewMode];
    if (viewMode === 'empenho') {
      commitmentData.forEach(item => {
        map[item.identity] = item;
      });
    } else if (budgetDimensionKey) {
      filteredOrcamentarioDetails.forEach(detail => {
        const rawKey = detail[budgetDimensionKey] || 'N/I';
        const keys = budgetDimensionKey === 'nd_codigo' ? splitBudgetDimensionValue(rawKey) : [rawKey];
        const nameKey = budgetDimensionKey.replace('_codigo', '_nome');
        const rawName = detail[nameKey] || 'N/I';
        const names = budgetDimensionKey === 'nd_codigo' ? splitBudgetDimensionValue(rawName) : [rawName];
        const normalizedKeys = keys.length ? keys : ['N/I'];
        const allocation = 1 / normalizedKeys.length;
        normalizedKeys.forEach((key, index) => {
          const dimensionName = names[index] || (names.length === 1 ? names[0] : 'N/I');
          if (!map[key]) map[key] = {
            label: key,
            contracts: new Set(),
            descriptions: new Set(),
            global: 0,
            total: 0,
            recebido: 0,
            liquidado: 0,
            a_liquidar: 0,
            pago: 0,
            a_pagar: 0,
            bloqueado: 0,
            cancelado: 0,
            executado: 0,
            fornecedor: ''
          };
          const target = map[key];
          target.contracts.add(UnifiedData.key(detail.contrato));
          target.descriptions.add(`${key} – ${dimensionName}`);
          target.total += (detail.v_empenhado || 0) * allocation;
          target.recebido += (detail.v_recebido || 0) * allocation;
          target.liquidado += (detail.v_liquidado || 0) * allocation;
          target.a_liquidar += (detail.v_a_liquidar || 0) * allocation;
          target.pago += (detail.v_pago || 0) * allocation;
          target.a_pagar += (detail.v_a_pagar || 0) * allocation;
          target.bloqueado += (detail.v_bloqueado || 0) * allocation;
          target.cancelado += (detail.v_cancelado || 0) * allocation;
          target.executado += (detail.v_executado || 0) * allocation;
        });
      });
    } else {
      filteredData.forEach(item => {
        const key = getTop20Key(item, viewMode);
        if (!map[key]) map[key] = {
          label: viewMode === 'contrato' ? item.contrato : key,
          contracts: new Set(),
          global: 0,
          total: 0,
          recebido: 0,
          liquidado: 0,
          a_liquidar: 0,
          pago: 0,
          a_pagar: 0,
          bloqueado: 0,
          cancelado: 0,
          executado: 0,
          fornecedor: item.fornecedor,
          tooltip: key
        };
        const target = map[key];
        target.contracts.add(UnifiedData.key(item.contrato));
        target.global += item.v_global || 0;
        target.total += item.v_empenhado || 0;
        target.recebido += item.v_recebido || 0;
        target.liquidado += item.v_liquidado || 0;
        target.a_liquidar += item.v_a_liquidar || 0;
        target.pago += item.v_pago || 0;
        target.a_pagar += item.v_a_pagar || 0;
        target.bloqueado += item.v_bloqueado || 0;
        target.cancelado += item.v_cancelado || 0;
        target.executado += item.v_executado || 0;
      });
    }
    const totalEmpenhadoOrcamentario = Object.values(map).reduce((sum, item) => sum + item.total, 0);
    let arr = Object.values(map).map(item => ({
      ...item,
      count: item.contracts.size,
      tooltip: item.descriptions ? Array.from(item.descriptions).join('\n') : item.tooltip,
      p_empenhado: item.global ? item.total / item.global : totalEmpenhadoOrcamentario ? item.total / totalEmpenhadoOrcamentario : 0,
      p_recebido: item.total ? item.recebido / item.total : 0,
      p_liquidado: item.total ? item.liquidado / item.total : 0,
      p_pago: item.total ? item.pago / item.total : 0,
      p_cancelado: item.total ? item.cancelado / item.total : 0,
      p_bloqueado: item.total ? item.bloqueado / item.total : 0,
      p_a_liquidar: item.total ? Math.max(0, item.a_liquidar) / item.total : 0,
      p_a_pagar: item.total ? Math.max(0, item.a_pagar) / item.total : 0
    }));
    sortTop20Array(arr, sortKey);
    return limit === null ? arr : arr.slice(0, limit);
  };
  const top20DataProcessed = useMemo(() => buildTop20Data(top20ViewMode, top20Sort), [filteredData, filteredOrcamentarioDetails, commitmentData, top20Sort, top20ViewMode]);
  const top20100DataProcessed = useMemo(() => buildTop20Data(top20100ViewMode, top20100Sort), [filteredData, filteredOrcamentarioDetails, commitmentData, top20100Sort, top20100ViewMode]);
  const top20AllDataProcessed = useMemo(() => buildTop20Data(top20ViewMode, top20Sort, null), [filteredData, filteredOrcamentarioDetails, commitmentData, top20Sort, top20ViewMode]);
  const top20100AllDataProcessed = useMemo(() => buildTop20Data(top20100ViewMode, top20100Sort, null), [filteredData, filteredOrcamentarioDetails, commitmentData, top20100Sort, top20100ViewMode]);

  // Performance and correlation share one immutable aggregate per filtered set.
  const canonicalChartRows = useMemo(() => ContractRules.aggregateContracts(filteredData), [filteredData]);
  const contratoAllData = useMemo(() => {
    const remaining = row => row.encerrando_dias === null || !Number.isFinite(row.encerrando_dias) ? null : row.encerrando_dias;
    const arr = canonicalChartRows.map(row => ({
      ...row,
      p_recebido: row.v_empenhado ? (row.v_recebido || 0) / row.v_empenhado : 0,
      p_liquidado: row.v_empenhado ? (row.v_liquidado || 0) / row.v_empenhado : 0,
      p_pago: row.v_empenhado ? (row.v_pago || 0) / row.v_empenhado : 0
    }));
    arr.sort((a, b) => {
      if (contratoSort === 'dias_asc' || contratoSort === 'dias_desc') {
        const av = remaining(a),
          bv = remaining(b);
        if (av === null) return bv === null ? 0 : 1;
        if (bv === null) return -1;
        return (contratoSort === 'dias_asc' ? av - bv : bv - av) || a.contrato.localeCompare(b.contrato, 'pt-BR', {
          numeric: true
        });
      }
      const field = contratoSort === 'recebido_desc' ? 'p_recebido' : contratoSort === 'liquidado_desc' ? 'p_liquidado' : 'p_pago';
      return (b[field] || 0) - (a[field] || 0) || a.contrato.localeCompare(b.contrato, 'pt-BR', {
        numeric: true
      });
    });
    return arr;
  }, [canonicalChartRows, contratoSort]);
  const contratoChartData = useMemo(() => contratoAllData.slice(0, 20), [contratoAllData]);
  const dataByAno = useMemo(() => {
    let minYear = 9999;
    let maxYear = 0;
    filteredData.forEach(d => {
      const yI = d.dtInicVal ? new Date(d.dtInicVal).getFullYear() : null;
      const yF = d.dtFimVal ? new Date(d.dtFimVal).getFullYear() : null;
      if (yI && yI < minYear) minYear = yI;
      if (yF && yF > maxYear) maxYear = yF;
    });
    const anos = [];
    if (minYear <= maxYear) {
      for (let y = minYear; y <= maxYear; y++) anos.push(y);
    }
    return anos.map(ano => {
      let inic = 0,
        enc = 0,
        dur = 0,
        emp = 0;
      filteredData.forEach(d => {
        const yI = d.dtInicVal ? new Date(d.dtInicVal).getFullYear() : null;
        const yF = d.dtFimVal ? new Date(d.dtFimVal).getFullYear() : null;
        if (yI === ano) {
          inic++;
          emp += d.v_empenhado;
        }
        if (yF === ano) enc++;
        if (yI !== null && yF !== null && yI < ano && yF > ano) dur++;
      });
      return {
        label: ano,
        iniciados: inic,
        encerrados: enc,
        durante: dur,
        empenhado: emp
      };
    });
  }, [filteredData]);
  const bubbleData = useMemo(() => {
    const contracts = canonicalChartRows;
    let maxEmp = 0;
    contracts.forEach(d => {
      if (d.v_empenhado > maxEmp) maxEmp = d.v_empenhado;
    });
    return contracts.filter(d => {
      const mainTag = ContractRules.primaryFlag(d.situacaoFlags);
      const tagLabel = mainTag ? mainTag.label : 'OUTROS';
      return !scatterHiddenTags.includes(tagLabel);
    }).map(d => {
      const mainTag = ContractRules.primaryFlag(d.situacaoFlags);
      const hexColor = mainTag ? mainTag.hex : '#94a3b8';
      return {
        x: Math.min(Math.max((d[scatterXAxis] || 0) * 100, -10), 110),
        y: Math.min(Math.max((d.perc_tempo || 0) * 100, -10), 110),
        r: maxEmp > 0 ? Math.max(4, d.v_empenhado / maxEmp * 25) : 4,
        contrato: d.contrato,
        objeto: d.objeto,
        fornecedor: d.fornecedor,
        v_empenhado: d.v_empenhado,
        v_recebido: d.v_recebido || 0,
        v_liquidado: d.v_liquidado || 0,
        v_pago: d.v_pago || 0,
        perc_tempo: d.perc_tempo || 0,
        dias_passaram: d.dias_passaram,
        duracao_total_dias: d.duracao_total_dias,
        situacao: d.situacao,
        color: hexColor
      };
    });
  }, [canonicalChartRows, scatterXAxis, scatterHiddenTags]);

  // Resumo de Contadores por Quadrante do Bubble Chart
  const q1Normal = bubbleData.filter(d => d.x <= 50 && d.y <= 50).length;
  const q2Ruim = bubbleData.filter(d => d.x <= 50 && d.y > 50).length;
  const q3Normal = bubbleData.filter(d => d.x > 50 && d.y > 50).length;
  const q4Otimo = bubbleData.filter(d => d.x > 50 && d.y <= 50).length;
  const totalBubbles = bubbleData.length;
  const pQ1 = totalBubbles ? (q1Normal / totalBubbles * 100).toFixed(1).replace('.', ',') + '%' : '0%';
  const pQ2 = totalBubbles ? (q2Ruim / totalBubbles * 100).toFixed(1).replace('.', ',') + '%' : '0%';
  const pQ3 = totalBubbles ? (q3Normal / totalBubbles * 100).toFixed(1).replace('.', ',') + '%' : '0%';
  const pQ4 = totalBubbles ? (q4Otimo / totalBubbles * 100).toFixed(1).replace('.', ',') + '%' : '0%';
  const scatterMetricLabels = {
    p_recebido: '% Recebido',
    p_liquidado: '% Liquidado',
    p_pago: '% Pago',
    p_executado: '% Executado'
  };
  const top20SubjectLabels = {
    fornecedor: 'FORNECEDOR',
    contrato: 'CONTRATO',
    empenho: 'EMPENHO / CONTRATO / EMITENTE',
    ano: 'ANO',
    modalidade: 'MODALIDADE',
    sec_log: 'SEC LOG',
    ao_codigo: 'AO CÓDIGO',
    nd_codigo: 'ND CÓDIGO',
    pi_codigo: 'PI CÓDIGO'
  };
  const buildPersonTableRows = data => {
    const totalQuantity = data.reduce((sum, item) => sum + item.qtd_tit + item.qtd_sub, 0);
    const totalValue = data.reduce((sum, item) => sum + item.emp_tit + item.emp_sub, 0);
    return data.map(item => ({
      ...item,
      qtd_total: item.qtd_tit + item.qtd_sub,
      pct_qtd: totalQuantity ? (item.qtd_tit + item.qtd_sub) / totalQuantity : 0,
      emp_total: item.emp_tit + item.emp_sub,
      pct_valor: totalValue ? (item.emp_tit + item.emp_sub) / totalValue : 0,
      _tooltip: item.label
    }));
  };
  const personTableColumns = subject => [{
    header: subject,
    key: 'label',
    align: 'left'
  }, {
    header: 'QTD TITULAR',
    key: 'qtd_tit'
  }, {
    header: 'QTD SUBSTITUTO',
    key: 'qtd_sub'
  }, {
    header: 'QUANTIDADE',
    key: 'qtd_total'
  }, {
    header: '% QTD',
    key: 'pct_qtd',
    isPercent: true
  }, {
    header: 'EMP. TITULAR',
    key: 'emp_tit',
    isCurrency: true
  }, {
    header: 'EMP. SUBSTITUTO',
    key: 'emp_sub',
    isCurrency: true
  }, {
    header: 'EMPENHADO',
    key: 'emp_total',
    isCurrency: true
  }, {
    header: '% VALOR',
    key: 'pct_valor',
    isPercent: true
  }];
  const gestorTableRows = buildPersonTableRows(gestorDataProcessed);
  const fiscalTableRows = buildPersonTableRows(fiscalDataProcessed);
  const buildTop20TableRows = (data, viewMode) => {
    const totalQuantity = data.reduce((sum, item) => sum + item.count, 0);
    const totalValue = data.reduce((sum, item) => sum + item.total, 0);
    return data.map(item => ({
      ...item,
      subject: viewMode === 'fornecedor' ? item.label.replace(/^[\d\.\-\/]+\s*-\s*/, '') : item.label,
      pct_qtd: totalQuantity ? item.count / totalQuantity : 0,
      pct_valor: totalValue ? item.total / totalValue : 0,
      a_liquidar_table: Math.max(0, item.a_liquidar),
      a_pagar_table: Math.max(0, item.a_pagar),
      p_empenhado_100: item.total ? 1 : 0,
      _tooltip: item.tooltip || (viewMode === 'contrato' ? `Fornecedor: ${item.fornecedor}` : item.label)
    }));
  };
  const top20TableRows = buildTop20TableRows(top20AllDataProcessed, top20ViewMode);
  const top20100TableRows = buildTop20TableRows(top20100AllDataProcessed, top20100ViewMode);
  const top20TableColumns = [{
    header: top20SubjectLabels[top20ViewMode],
    key: 'subject',
    align: 'left'
  }, {
    header: 'CONTRATO',
    key: 'contrato',
    align: 'left'
  }, {
    header: 'EMPENHO',
    key: 'empenho',
    align: 'left'
  }, {
    header: 'EMITENTE',
    key: 'ug',
    align: 'left'
  }, {
    header: 'QUANTIDADE',
    key: 'count'
  }, {
    header: '% QTD',
    key: 'pct_qtd',
    isPercent: true
  }, {
    header: 'EMPENHADO',
    key: 'total',
    isCurrency: true
  }, {
    header: '% VALOR',
    key: 'pct_valor',
    isPercent: true
  }, {
    header: 'RECEBIDO',
    key: 'recebido',
    isCurrency: true
  }, {
    header: 'LIQUIDADO',
    key: 'liquidado',
    isCurrency: true
  }, {
    header: 'PAGO',
    key: 'pago',
    isCurrency: true
  }, {
    header: 'BLOQUEADO',
    key: 'bloqueado',
    isCurrency: true
  }, {
    header: 'CANCELADO',
    key: 'cancelado',
    isCurrency: true
  }, {
    header: 'A LIQUIDAR',
    key: 'a_liquidar_table',
    isCurrency: true
  }, {
    header: 'A PAGAR',
    key: 'a_pagar_table',
    isCurrency: true
  }].filter(column => top20ViewMode === 'empenho' || !['contrato', 'empenho', 'ug'].includes(column.key));
  const top20100TableColumns = [{
    header: top20SubjectLabels[top20100ViewMode],
    key: 'subject',
    align: 'left'
  }, {
    header: 'CONTRATO',
    key: 'contrato',
    align: 'left'
  }, {
    header: 'EMPENHO',
    key: 'empenho',
    align: 'left'
  }, {
    header: 'EMITENTE',
    key: 'ug',
    align: 'left'
  }, {
    header: 'QUANTIDADE',
    key: 'count'
  }, {
    header: '% QTD',
    key: 'pct_qtd',
    isPercent: true
  }, {
    header: 'EMPENHADO',
    key: 'total',
    isCurrency: true
  }, {
    header: '% VALOR',
    key: 'pct_valor',
    isPercent: true
  }, {
    header: 'EMPENHADO (100 %)',
    key: 'p_empenhado_100',
    isPercent: true
  }, {
    header: 'RECEBIDO %',
    key: 'p_recebido',
    isPercent: true
  }, {
    header: 'LIQUIDADO %',
    key: 'p_liquidado',
    isPercent: true
  }, {
    header: 'A LIQUIDAR %',
    key: 'p_a_liquidar',
    isPercent: true
  }, {
    header: 'PAGO %',
    key: 'p_pago',
    isPercent: true
  }, {
    header: 'BLOQUEADO %',
    key: 'p_bloqueado',
    isPercent: true
  }, {
    header: 'CANCELADO %',
    key: 'p_cancelado',
    isPercent: true
  }, {
    header: 'A PAGAR %',
    key: 'p_a_pagar',
    isPercent: true
  }].filter(column => top20100ViewMode === 'empenho' || !['contrato', 'empenho', 'ug'].includes(column.key));
  const totalsByYear = dataByAno.reduce((totals, item) => ({
    iniciados: totals.iniciados + item.iniciados,
    encerrados: totals.encerrados + item.encerrados,
    durante: totals.durante + item.durante,
    empenhado: totals.empenhado + item.empenhado
  }), {
    iniciados: 0,
    encerrados: 0,
    durante: 0,
    empenhado: 0
  });
  const yearTableRows = dataByAno.map(item => ({
    ...item,
    p_iniciados: totalsByYear.iniciados ? item.iniciados / totalsByYear.iniciados : 0,
    p_encerrados: totalsByYear.encerrados ? item.encerrados / totalsByYear.encerrados : 0,
    p_durante: totalsByYear.durante ? item.durante / totalsByYear.durante : 0,
    p_valor: totalsByYear.empenhado ? item.empenhado / totalsByYear.empenhado : 0,
    _tooltip: String(item.label)
  }));
  const yearTableColumns = [{
    header: 'ANO',
    key: 'label',
    align: 'left'
  }, {
    header: 'INICIADOS',
    key: 'iniciados'
  }, {
    header: '% INICIADOS',
    key: 'p_iniciados',
    isPercent: true
  }, {
    header: 'ENCERRADOS',
    key: 'encerrados'
  }, {
    header: '% ENCERRADOS',
    key: 'p_encerrados',
    isPercent: true
  }, {
    header: 'DURANTE',
    key: 'durante'
  }, {
    header: '% DURANTE',
    key: 'p_durante',
    isPercent: true
  }, {
    header: 'EMPENHADO',
    key: 'empenhado',
    isCurrency: true
  }, {
    header: '% VALOR',
    key: 'p_valor',
    isPercent: true
  }];
  const contractTableValueTotal = contratoAllData.reduce((sum, item) => sum + item.v_empenhado, 0);
  const contractTableRows = contratoAllData.map(item => ({
    ...item,
    pct_qtd: contratoAllData.length ? 1 / contratoAllData.length : 0,
    pct_valor: contractTableValueTotal ? item.v_empenhado / contractTableValueTotal : 0,
    _tooltip: `Objeto: ${item.objeto}\nFornecedor: ${item.fornecedor}`
  }));
  const contractTableColumns = [{
    header: 'CONTRATO',
    key: 'contrato',
    align: 'left'
  }, {
    header: 'FORNECEDOR',
    key: 'fornecedor',
    align: 'left'
  }, {
    header: 'OBJETO',
    key: 'objeto',
    align: 'left'
  }, {
    header: 'DIAS RESTANTES',
    key: 'encerrando_dias'
  }, {
    header: '% TEMPO',
    key: 'perc_tempo',
    isPercent: true
  }, {
    header: 'VALOR EMPENHADO',
    key: 'v_empenhado',
    isCurrency: true
  }, {
    header: '% RECEBIDO',
    key: 'p_recebido',
    isPercent: true
  }, {
    header: '% LIQUIDADO',
    key: 'p_liquidado',
    isPercent: true
  }, {
    header: '% PAGO',
    key: 'p_pago',
    isPercent: true
  }];
  const scatterValueTotal = bubbleData.reduce((sum, item) => sum + item.v_empenhado, 0);
  const scatterTableRows = bubbleData.map(item => ({
    ...item,
    qtd_table: 1,
    pct_qtd: bubbleData.length ? 1 / bubbleData.length : 0,
    pct_valor: scatterValueTotal ? item.v_empenhado / scatterValueTotal : 0,
    p_axis: item.x / 100,
    p_tempo_table: item.y / 100,
    p_recebido_table: item.v_empenhado ? item.v_recebido / item.v_empenhado : 0,
    p_liquidado_table: item.v_empenhado ? item.v_liquidado / item.v_empenhado : 0,
    p_pago_table: item.v_empenhado ? item.v_pago / item.v_empenhado : 0,
    _tooltip: `Objeto: ${item.objeto}\nFornecedor: ${item.fornecedor}\nSituação: ${item.situacao}`
  }));
  const scatterTableColumns = [{
    header: 'CONTRATO',
    key: 'contrato',
    align: 'left'
  }, {
    header: 'OBJETO',
    key: 'objeto',
    align: 'left'
  }, {
    header: 'FORNECEDOR',
    key: 'fornecedor',
    align: 'left'
  }, {
    header: 'SITUAÇÃO',
    key: 'situacao',
    align: 'left'
  }, {
    header: 'QUANTIDADE',
    key: 'qtd_table'
  }, {
    header: '% QTD',
    key: 'pct_qtd',
    isPercent: true
  }, {
    header: 'EMPENHADO',
    key: 'v_empenhado',
    isCurrency: true
  }, {
    header: '% VALOR',
    key: 'pct_valor',
    isPercent: true
  }, {
    header: 'RECEBIDO',
    key: 'v_recebido',
    isCurrency: true
  }, {
    header: 'RECEBIDO %',
    key: 'p_recebido_table',
    isPercent: true
  }, {
    header: 'LIQUIDADO',
    key: 'v_liquidado',
    isCurrency: true
  }, {
    header: 'LIQUIDADO %',
    key: 'p_liquidado_table',
    isPercent: true
  }, {
    header: 'PAGO',
    key: 'v_pago',
    isCurrency: true
  }, {
    header: 'PAGO %',
    key: 'p_pago_table',
    isPercent: true
  }, {
    header: scatterMetricLabels[scatterXAxis].toUpperCase(),
    key: 'p_axis',
    isPercent: true
  }, {
    header: '% TEMPO',
    key: 'p_tempo_table',
    isPercent: true
  }];
  const masterNonMetricColCount = ['contrato', 'arquivos', 'situacao', 'secLog', 'fornecedor', 'objeto', 'gestorFiscal', 'ao', 'po', 'nd', 'dataInic', 'dataFim', 'percTempo', 'diasPassaram', 'encerrandoDias'].filter(k => masterVisibleCols[k]).length;
  const masterLeadingTextColCount = ['contrato', 'arquivos', 'situacao', 'secLog', 'fornecedor', 'objeto', 'gestorFiscal'].filter(key => masterVisibleCols[key]).length;
  const getMasterExportCols = () => {
    let cols = [];
    if (masterVisibleCols.contrato) cols.push({
      header: "CONTRATO/COMPRA",
      key: "contrato"
    });
    if (masterVisibleCols.arquivos) cols.push(...ContractFiles.exportColumns());
    if (masterVisibleCols.situacao) cols.push({
      header: "SITUAÇÃO",
      key: "situacao"
    });
    if (masterVisibleCols.secLog) cols.push({
      header: "SEC LOG",
      key: "sec_log"
    });
    if (masterVisibleCols.fornecedor) cols.push({
      header: "FORNECEDOR",
      key: "fornecedor"
    });
    if (masterVisibleCols.objeto) cols.push({
      header: "OBJETO",
      key: "objeto"
    });
    if (masterVisibleCols.gestorFiscal) cols.push({
      header: "GESTOR/FISCAL",
      key: "gestor",
      format: r => `GT: ${r.gestor} | GS: ${r.gestor_sub} | FT: ${r.fiscal} | FS: ${r.fiscal_sub}`
    });
    if (masterVisibleCols.dataInic) cols.push({
      header: "INÍCIO",
      key: "data_inic"
    });
    if (masterVisibleCols.dataFim) cols.push({
      header: "FIM",
      key: "data_fim"
    });
    if (masterVisibleCols.percTempo) cols.push({
      header: "% TEMPO",
      key: "perc_tempo",
      isPercent: true
    });
    if (masterVisibleCols.diasPassaram) cols.push({
      header: "PASSARAM",
      key: "dias_passaram"
    });
    if (masterVisibleCols.encerrandoDias) cols.push({
      header: "FALTAM",
      key: "encerrando_dias"
    });
    if (masterVisibleCols.ao) cols.push({
      header: "AO",
      key: "ao_codigos"
    });
    if (masterVisibleCols.po) cols.push({
      header: "PO",
      key: "po_codigos"
    });
    if (masterVisibleCols.nd) cols.push({
      header: "ND",
      key: "nd_codigos"
    });
    if (masterVisibleCols.difGlobal) cols.push({
      header: "GLOBAL-EMP",
      key: "dif_global",
      isCurrency: true
    });
    if (masterVisibleCols.vGlobal) cols.push({
      header: "GLOBAL",
      key: "v_global",
      isCurrency: true
    });
    if (masterVisibleCols.empenhado) cols.push({
      header: "EMPENHADO",
      key: "v_empenhado",
      isCurrency: true
    });
    if (masterVisibleCols.recebido) cols.push({
      header: "RECEBIDO",
      key: "v_recebido",
      isCurrency: true
    });
    if (masterVisibleCols.pRecebido) cols.push({
      header: "RCB %",
      key: "p_recebido",
      isPercent: true
    });
    if (masterVisibleCols.liquidado) cols.push({
      header: "LIQUIDADO",
      key: "v_liquidado",
      isCurrency: true
    });
    if (masterVisibleCols.pLiquidado) cols.push({
      header: "LIQ %",
      key: "p_liquidado",
      isPercent: true
    });
    if (masterVisibleCols.aLiquidar) cols.push({
      header: "A LIQUIDAR",
      key: "v_a_liquidar",
      isCurrency: true
    });
    if (masterVisibleCols.pALiquidar) cols.push({
      header: "A LIQ %",
      key: "p_a_liquidar",
      isPercent: true
    });
    if (masterVisibleCols.pago) cols.push({
      header: "PAGO",
      key: "v_pago",
      isCurrency: true
    });
    if (masterVisibleCols.pPago) cols.push({
      header: "PAGO %",
      key: "p_pago",
      isPercent: true
    });
    if (masterVisibleCols.aPagar) cols.push({
      header: "A PAGAR",
      key: "v_a_pagar",
      isCurrency: true
    });
    if (masterVisibleCols.pAPagar) cols.push({
      header: "A PAGAR %",
      key: "p_a_pagar",
      isPercent: true
    });
    if (masterVisibleCols.bloqueado) cols.push({
      header: "BLOQUEADO",
      key: "v_bloqueado",
      isCurrency: true
    });
    if (masterVisibleCols.pBloqueado) cols.push({
      header: "BLOQ %",
      key: "p_bloqueado",
      isPercent: true
    });
    if (masterVisibleCols.cancelado) cols.push({
      header: "CANCELADO",
      key: "v_cancelado",
      isCurrency: true
    });
    if (masterVisibleCols.pCancelado) cols.push({
      header: "CANC %",
      key: "p_cancelado",
      isPercent: true
    });
    if (masterVisibleCols.executado) cols.push({
      header: "EXECUTADO",
      key: "v_executado",
      isCurrency: true
    });
    if (masterVisibleCols.pExecutado) cols.push({
      header: "EXEC %",
      key: "p_executado",
      isPercent: true
    });
    if (masterVisibleCols.execLiq) cols.push({
      header: "EXEC LIQ",
      key: "v_pago",
      isCurrency: true
    });
    if (masterVisibleCols.pExecLiq) cols.push({
      header: "EXEC LIQ %",
      key: "p_pago",
      isPercent: true
    });
    return cols;
  };
  const renderBudgetDetailRow = (detail, key) => /*#__PURE__*/React.createElement("tr", {
    key: key,
    className: "budget-detail-row border-t border-blue-100 bg-blue-50/60"
  }, masterLeadingTextColCount > 0 && /*#__PURE__*/React.createElement("td", {
    colSpan: masterLeadingTextColCount,
    className: "master-text-col p-3 text-[9px] font-black text-blue-700 uppercase tracking-wider"
  }, "Detalhe ", (detail._dimensions || ['ao', 'po', 'nd']).map(item => item.toUpperCase()).join('–')), masterVisibleCols.dataInic && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center text-slate-300"
  }, "\u2014"), masterVisibleCols.dataFim && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center text-slate-300"
  }, "\u2014"), masterVisibleCols.percTempo && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center text-slate-300"
  }, "\u2014"), masterVisibleCols.diasPassaram && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center text-slate-300"
  }, "\u2014"), masterVisibleCols.encerrandoDias && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center text-slate-300"
  }, "\u2014"), masterVisibleCols.ao && /*#__PURE__*/React.createElement("td", {
    className: "master-code-col p-3 font-black text-blue-800",
    title: detail.ao_codigo ? `${detail.ao_nome} – ${detail.ao_codigo}` : ''
  }, detail.ao_codigo || '—'), masterVisibleCols.po && /*#__PURE__*/React.createElement("td", {
    className: "master-code-col p-3 font-black text-blue-800",
    title: detail.po_codigo ? `${detail.po_nome} – ${detail.po_codigo}` : ''
  }, detail.po_codigo || '—'), masterVisibleCols.nd && /*#__PURE__*/React.createElement("td", {
    className: "master-code-col p-3 font-black text-blue-800",
    title: detail.nd_codigo ? `${detail.nd_nome} – ${detail.nd_codigo}` : ''
  }, detail.nd_codigo || '—'), masterVisibleCols.difGlobal && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center text-[8px] font-black text-blue-700 uppercase"
  }, (detail._dimensions || ['ao', 'po', 'nd']).map(item => item.toUpperCase()).join('–')), masterVisibleCols.vGlobal && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center text-slate-300"
  }, "\u2014"), masterVisibleCols.empenhado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-blue-700",
    "data-metric": "empenhado",
    style: MetricColors.textStyle('empenhado')
  }, formatBRL(detail.v_empenhado)), masterVisibleCols.recebido && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-violet-700"
  }, formatBRL(detail.v_recebido)), masterVisibleCols.pRecebido && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold text-violet-700"
  }, formatPercentBR(detail.p_recebido)), masterVisibleCols.liquidado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-amber-600",
    "data-metric": "liquidado",
    style: MetricColors.textStyle('liquidado')
  }, formatBRL(detail.v_liquidado)), masterVisibleCols.pLiquidado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold",
    "data-metric": "liquidado",
    style: MetricColors.textStyle('liquidado')
  }, formatPercentBR(detail.p_liquidado)), masterVisibleCols.aLiquidar && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-amber-500"
  }, formatBRL(detail.v_a_liquidar)), masterVisibleCols.pALiquidar && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold"
  }, formatPercentBR(detail.p_a_liquidar)), masterVisibleCols.pago && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-emerald-600",
    "data-metric": "pago",
    style: MetricColors.textStyle('pago')
  }, formatBRL(detail.v_pago)), masterVisibleCols.pPago && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold",
    "data-metric": "pago",
    style: MetricColors.textStyle('pago')
  }, formatPercentBR(detail.p_pago)), masterVisibleCols.aPagar && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-emerald-500"
  }, formatBRL(detail.v_a_pagar)), masterVisibleCols.pAPagar && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold"
  }, formatPercentBR(detail.p_a_pagar)), masterVisibleCols.bloqueado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-orange-600",
    "data-metric": "bloqueado",
    style: MetricColors.textStyle('bloqueado')
  }, formatBRL(detail.v_bloqueado)), masterVisibleCols.pBloqueado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold",
    "data-metric": "bloqueado",
    style: MetricColors.textStyle('bloqueado')
  }, formatPercentBR(detail.p_bloqueado)), masterVisibleCols.cancelado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-red-600",
    "data-metric": "cancelado",
    style: MetricColors.textStyle('cancelado')
  }, formatBRL(detail.v_cancelado)), masterVisibleCols.pCancelado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold",
    "data-metric": "cancelado",
    style: MetricColors.textStyle('cancelado')
  }, formatPercentBR(detail.p_cancelado)), masterVisibleCols.executado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-blue-600"
  }, formatBRL(detail.v_executado)), masterVisibleCols.pExecutado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold text-blue-800"
  }, formatPercentBR(detail.p_executado)), masterVisibleCols.execLiq && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right font-bold text-violet-600",
    "data-metric": "pago",
    style: MetricColors.textStyle('pago')
  }, formatBRL(detail.v_pago)), masterVisibleCols.pExecLiq && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center font-bold text-violet-800",
    "data-metric": "pago",
    style: MetricColors.textStyle('pago')
  }, formatPercentBR(detail.p_exec_liq)));
  if (loading) return /*#__PURE__*/React.createElement("div", {
    className: "h-screen flex flex-col items-center justify-center font-black text-slate-400 gap-4"
  }, /*#__PURE__*/React.createElement("div", {
    className: "w-12 h-12 border-4 border-slate-300 border-t-slate-800 rounded-full animate-spin"
  }), /*#__PURE__*/React.createElement("p", null, "A PROCESSAR LIGA\xC7\xC3O..."));
  return /*#__PURE__*/React.createElement("div", {
    className: "p-4 md:p-8 relative"
  }, summaryRequested && loginSummary && /*#__PURE__*/React.createElement(LoginSummaryModal, {
    summary: loginSummary,
    user: currentUser,
    onClose: closeSummary
  }), /*#__PURE__*/React.createElement("header", {
    className: "max-w-[1600px] mx-auto mb-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pt-12"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    className: "text-3xl font-black uppercase tracking-tighter text-slate-800"
  }, "PAINEL DE CONTRATOS"), /*#__PURE__*/React.createElement("p", {
    className: `text-[11px] font-bold mt-1 ${status.includes("Erro") || status.includes("falhou") || status.includes("Falha") ? "text-red-600" : "text-emerald-600"}`
  }, "\u25CF ", status), linkDiagnostics && (linkDiagnostics.ambiguos > 0 || linkDiagnostics.colunasAusentes) && /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-amber-700 mt-2"
  }, linkDiagnostics.colunasAusentes ? "Classificação orçamentária indisponível: conferir cabeçalhos das fontes." : `${linkDiagnostics.ambiguos} registro(s) orçamentário(s) com vínculo ambíguo. Confira contrato e emitente na origem.`), missingFileColumns.length > 0 && /*#__PURE__*/React.createElement("p", {
    role: "status",
    className: "text-xs text-amber-700 mt-2"
  }, "A fonte de dados n\xE3o enviou todas as colunas de ARQUIVOS. Atualize a API e clique em SINCRONIZAR APIs para carregar os links."), metadataConflictCount > 0 && /*#__PURE__*/React.createElement("p", {
    className: "text-xs text-amber-700 mt-2"
  }, metadataConflictCount, " contrato(s) com metadados divergentes na base geral. Vig\xEAncia e classifica\xE7\xE3o usam o primeiro registro; os saldos das linhas distintas foram somados.")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-3 items-center bg-white px-5 py-3 rounded-xl border border-slate-200 shadow-sm max-w-full"
  }, /*#__PURE__*/React.createElement(AccessMetadata, null), /*#__PURE__*/React.createElement("div", {
    className: "w-[1px] h-8 bg-slate-300 mx-1 hidden md:block shrink-0"
  }), /*#__PURE__*/React.createElement("span", {
    className: "text-[11px] font-black text-slate-500 uppercase whitespace-nowrap ml-1 shrink-0"
  }, "LOGADO COMO: ", /*#__PURE__*/React.createElement("span", {
    className: "text-blue-600"
  }, String(currentUser || 'Usuário').toUpperCase()), currentPerfil && /*#__PURE__*/React.createElement("span", {
    className: "text-slate-400"
  }, " (", String(currentPerfil).toUpperCase(), ")")), /*#__PURE__*/React.createElement("div", {
    className: "flex max-w-full flex-wrap items-center gap-2",
    "aria-label": "A\xE7\xF5es da sess\xE3o"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => loadData(true, null),
    className: "text-[11px] font-black text-white bg-blue-600 px-4 py-3 rounded-lg shadow hover:bg-blue-700 transition uppercase tracking-wider whitespace-nowrap shrink-0"
  }, "SINCRONIZAR APIs"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: logout,
    className: "text-[11px] font-black text-white bg-red-600 px-4 py-3 rounded-lg shadow hover:bg-red-700 transition uppercase tracking-wider whitespace-nowrap shrink-0"
  }, "SAIR")))), /*#__PURE__*/React.createElement(PageNavigation, {
    activePage: activePage,
    onPageChange: setActivePage
  }), /*#__PURE__*/React.createElement(CollapsibleSection, {
    title: "FILTROS DIN\xC2MICOS (INTEGRADOS)",
    defaultOpen: true,
    globalTrigger: expandTrigger,
    globalState: globalExpandState
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto mb-6 bg-white p-5 rounded-2xl shadow-sm border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-4 pb-4 border-b border-slate-100 flex flex-col gap-3"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "filter-subtitle"
  }, "A\xE7\xF5es r\xE1pidas de contratos"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2 items-center"
  }, /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.current(todayStr),
    onClick: toggleVigentes,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isVigentesActive ? 'bg-emerald-600 text-white border-emerald-600 ring-2 ring-emerald-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "CONTR VIGENTES"), /*#__PURE__*/React.createElement("button", {
    title: "Mostra todas as se\xE7\xF5es log\xEDsticas permitidas para seu usu\xE1rio, retirando somente o filtro SEC LOG. Os demais filtros continuam valendo.",
    onClick: showCOLOG,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${fSecLog.length === 0 ? 'bg-blue-600 text-white border-blue-600 ring-2 ring-blue-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "COLOG"), /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.cSup(cSupItems),
    onClick: toggleCSup,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isCSupActive ? 'bg-blue-600 text-white border-blue-600 ring-2 ring-blue-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "C SUP"), /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.outsideCSup,
    onClick: toggleNonCSup,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isNonCSupActive ? 'bg-indigo-600 text-white border-indigo-600 ring-2 ring-indigo-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "COLOG \u2013 C SUP"), /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.clear,
    onClick: clearAllFilters,
    className: "text-[9px] font-bold uppercase bg-slate-800 text-white px-3 py-1.5 rounded hover:bg-slate-700 transition shadow-md border border-slate-800"
  }, "Limpar Filtros")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2 items-center"
  }, /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.ending(7, todayStr, sevenDaysAheadStr),
    onClick: toggleVencendo7,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isVencendo7Active ? 'bg-lime-600 text-white border-lime-600 ring-2 ring-lime-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "CONTR VENCENDO EM 7 DIAS"), /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.ending(30, todayStr, thirtyDaysAheadStr),
    onClick: toggleVencendo30,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isVencendo30Active ? 'bg-teal-600 text-white border-teal-600 ring-2 ring-teal-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "CONTR VENCENDO EM 30 DIAS"), /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.existing(7, sevenDaysAgoStr),
    onClick: toggleSevenDays,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isSevenActive ? 'bg-amber-600 text-white border-amber-600 ring-2 ring-amber-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "CONTR EXISTENTES H\xC1 7 DIAS"), /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.existing(30, thirtyDaysAgoStr),
    onClick: toggleThirtyDays,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isThirtyActive ? 'bg-orange-600 text-white border-orange-600 ring-2 ring-orange-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "CONTR EXISTENTES H\xC1 30 DIAS"), /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.expired(7, sevenDaysAgoStr, todayStr),
    onClick: toggleVencidos7,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isVencidos7Active ? 'bg-rose-600 text-white border-rose-600 ring-2 ring-rose-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "CONTR VENCIDOS H\xC1 7 DIAS"), /*#__PURE__*/React.createElement("button", {
    title: QuickActionHelp.expired(30, thirtyDaysAgoStr, todayStr),
    onClick: toggleVencidos30,
    className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isVencidos30Active ? 'bg-red-700 text-white border-red-700 ring-2 ring-red-400 ring-offset-1' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`
  }, "CONTR VENCIDOS H\xC1 30 DIAS")), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2 items-center"
  }, Object.entries(tagColorsMap).map(_ref57 => {
    let [label, config] = _ref57;
    const isActive = fSituacaoTags.includes(label);
    return /*#__PURE__*/React.createElement("button", {
      key: label,
      title: QuickActionHelp.status(label),
      onClick: () => toggleSituacaoTag(label),
      className: `text-[9px] font-bold uppercase px-3 py-1.5 rounded transition shadow-sm border ${isActive ? config.css + ' border-transparent shadow-inner ring-2 ring-blue-400 ring-offset-1' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`
    }, label);
  })), documentDashboard.actions), /*#__PURE__*/React.createElement("h3", {
    className: "filter-subtitle"
  }, "Contratos"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-4"
  }, /*#__PURE__*/React.createElement(MultiSelect, {
    label: "FISCAL",
    options: filterOptions.fiscal,
    selected: fFiscal,
    onChange: setFFiscal
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "GESTOR",
    options: filterOptions.gestor,
    selected: fGestor,
    onChange: setFGestor
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "F. SUBSTITUTO",
    options: filterOptions.fiscal_sub,
    selected: fFiscalSub,
    onChange: setFFiscalSub
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "G. SUBSTITUTO",
    options: filterOptions.gestor_sub,
    selected: fGestorSub,
    onChange: setFGestorSub
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "SEC LOG",
    options: filterOptions.sec_log,
    selected: fSecLog,
    onChange: setFSecLog
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "CONTRATO",
    options: filterOptions.contrato,
    selected: fContrato,
    onChange: setFContrato
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "N\xBA COMPRA",
    options: filterOptions.compra,
    selected: fCompra,
    onChange: setFCompra
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "MODALIDADE",
    options: filterOptions.modalidade,
    selected: fModalidade,
    onChange: setFModalidade
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "FORNECEDOR",
    options: filterOptions.fornecedor,
    selected: fFornecedor,
    onChange: setFFornecedor
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4"
  }, /*#__PURE__*/React.createElement(DateInput, {
    label: "VIG\xCANCIA IN\xCDCIO (DE)",
    value: dInicDe,
    onChange: setDInicDe
  }), /*#__PURE__*/React.createElement(DateInput, {
    label: "VIG\xCANCIA IN\xCDCIO (AT\xC9)",
    value: dInicAte,
    onChange: setDInicAte
  }), /*#__PURE__*/React.createElement(DateInput, {
    label: "VIG\xCANCIA FIM (DE)",
    value: dFimDe,
    onChange: setDFimDe
  }), /*#__PURE__*/React.createElement(DateInput, {
    label: "VIG\xCANCIA FIM (AT\xC9)",
    value: dFimAte,
    onChange: setDFimAte
  })), documentDashboard.filters, /*#__PURE__*/React.createElement("h3", {
    className: "filter-subtitle"
  }, "Or\xE7amento"), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4"
  }, /*#__PURE__*/React.createElement(MultiSelect, {
    label: "AO C\xD3DIGO \u2013 NOME",
    options: filterOptions.ao_filter_values,
    selected: fAo,
    onChange: setFAo
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "PO C\xD3DIGO \u2013 NOME",
    options: filterOptions.po_filter_values,
    selected: fPo,
    onChange: setFPo
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "PTRES",
    options: filterOptions.ptres_values,
    selected: fPtres,
    onChange: setFPtres
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "PI NOME \u2013 C\xD3DIGO",
    options: filterOptions.pi_filter_values,
    selected: fPi,
    onChange: setFPi
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "GRUPO C\xD3DIGO",
    options: filterOptions.nd_grupo_values,
    selected: fGrupo,
    onChange: setFGrupo
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "MODALIDADE C\xD3DIGO",
    options: filterOptions.nd_modalidade_values,
    selected: fNdModalidade,
    onChange: setFNdModalidade
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "ELEMENTO C\xD3DIGO",
    options: filterOptions.nd_elemento_values,
    selected: fElemento,
    onChange: setFElemento
  }), /*#__PURE__*/React.createElement(MultiSelect, {
    label: "SUBELEMENTO C\xD3DIGO \u2013 NOME",
    options: filterOptions.nd_subelemento_filter_values,
    selected: fSubelemento,
    onChange: setFSubelemento
  })))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto flex justify-end mb-3"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: toggleAllSections,
    className: "text-[11px] font-black text-white bg-slate-800 px-5 py-3 rounded-xl shadow-lg hover:bg-slate-700 transition uppercase tracking-wider"
  }, globalExpandState ? '▼ RECOLHER TODAS AS SEÇÕES' : '► EXPANDIR TODAS AS SEÇÕES')), /*#__PURE__*/React.createElement(CollapsibleSection, {
    title: "INDICADORES DE DESEMPENHO",
    defaultOpen: false,
    globalTrigger: expandTrigger,
    globalState: globalExpandState
  }, /*#__PURE__*/React.createElement("h3", {
    className: "filter-subtitle max-w-[1600px] mx-auto"
  }, "Contratos"), /*#__PURE__*/React.createElement("p", {
    className: "max-w-[1600px] mx-auto mb-3 text-xs text-slate-500"
  }, "As situa\xE7\xF5es de execu\xE7\xE3o s\xE3o exclusivas. CAN e BLOQ s\xE3o tags adicionais. As quantidades de vigentes e vencidos contam cada contrato uma \xFAnica vez."), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-4 mb-4"
  }, /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Contratos",
    value: kpis.qtdContratos,
    extraText: `SÓ GERAL: ${documentDashboard.countSoGeral}\nSÓ CONTÁBIL: ${documentDashboard.countSoContabil}`,
    color: "slate",
    isCurrency: false
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Vigentes",
    value: kpis.qtdAtivos,
    extraText: `Sem exec: ${kpis.qtdAtivosInexec}\nEm Exec: ${kpis.qtdAtivosEmExec}\nExec Tot: ${kpis.qtdAtivosExecTot}\nExec Parc: ${kpis.qtdAtivosExecParc}`,
    color: "blue",
    isCurrency: false
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Vencidos",
    value: kpis.qtdVencidos,
    extraText: `Inexec total: ${kpis.qtdVencInexecTot}\nExec Tot: ${kpis.qtdVencidosTot}\nExec Parc: ${kpis.qtdVencidosParc}`,
    color: "slate",
    isCurrency: false
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Bloqueados",
    value: kpis.qtdBloqueados,
    color: "orange",
    isCurrency: false
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Cancelados",
    value: kpis.qtdCancelados,
    color: "red",
    isCurrency: false
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Gestores",
    value: kpis.qtdGestores,
    extraText: `Titular: ${kpis.qtdGestoresTit}
Substituto: ${kpis.qtdGestoresSub}`,
    color: "amber",
    isCurrency: false
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Fiscais",
    value: kpis.qtdFiscais,
    extraText: `Titular: ${kpis.qtdFiscaisTit}
Substituto: ${kpis.qtdFiscaisSub}`,
    color: "emerald",
    isCurrency: false
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Fornecedores",
    value: kpis.qtdFornecedores,
    color: "violet",
    isCurrency: false
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "QTD Sec Log",
    value: kpis.qtdSecLog,
    color: "cyan",
    isCurrency: false
  })), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto"
  }, documentDashboard.indicators), /*#__PURE__*/React.createElement("h3", {
    className: "filter-subtitle max-w-[1600px] mx-auto"
  }, "Or\xE7amento e execu\xE7\xE3o dos contratos"), documentDashboard.contractKeys && /*#__PURE__*/React.createElement("p", {
    className: "max-w-[1600px] mx-auto text-xs text-slate-500 mb-4"
  }, "Valores integrais dos contratos relacionados aos documentos selecionados. Os valores dos lan\xE7amentos selecionados aparecem nas p\xE1ginas 2, 4 e 5."), receivedWithoutClassification !== 0 && /*#__PURE__*/React.createElement("p", {
    className: "max-w-[1600px] mx-auto text-xs text-amber-700 mb-4"
  }, "Recebido sem classifica\xE7\xE3o or\xE7ament\xE1ria \xFAnica: ", formatBRL(receivedWithoutClassification), ". Esse valor est\xE1 no total dos contratos e n\xE3o \xE9 rateado nos gr\xE1ficos e detalhes por classifica\xE7\xE3o."), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-9 gap-4 mb-8"
  }, /*#__PURE__*/React.createElement(KPICard, {
    title: "Global",
    value: kpis.global,
    color: "slate",
    isCurrency: true
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "Empenhado",
    value: kpis.emp,
    subValue: kpis.pEmpGlobal,
    subLabel: "do Global",
    diffLabel: "Dif (Glob-Emp)",
    diffValue: kpis.global - kpis.emp,
    color: "blue",
    isCurrency: true
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "Recebido",
    value: kpis.rec,
    subValue: kpis.pRec,
    diffLabel: "Dif (Emp-Rcb)",
    diffValue: kpis.emp - kpis.rec,
    color: "violet",
    isCurrency: true
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "Liquidado",
    value: kpis.liq,
    subValue: kpis.pLiq,
    diffLabel: "Dif (Rcb-Liq)",
    diffValue: kpis.rec - kpis.liq,
    color: "amber",
    isCurrency: true
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "Pago",
    value: kpis.pag,
    subValue: kpis.pPag,
    diffLabel: "Dif (Liq-Pag)",
    diffValue: kpis.liq - kpis.pag,
    color: "emerald",
    isCurrency: true
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "Bloqueado",
    value: kpis.blo,
    subValue: kpis.pBlo,
    diffLabel: "Dif (Emp-Blq)",
    diffValue: kpis.emp - kpis.blo,
    color: "orange",
    isCurrency: true
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "Cancelado",
    value: kpis.can,
    subValue: kpis.pCan,
    diffLabel: "Dif (Emp-Can)",
    diffValue: kpis.emp - kpis.can,
    color: "red",
    isCurrency: true
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "Executado",
    value: kpis.exe,
    subValue: kpis.pExe,
    color: "blue",
    isCurrency: true
  }), /*#__PURE__*/React.createElement(KPICard, {
    title: "Executado L\xEDquido",
    value: kpis.pag,
    subValue: kpis.pPag,
    color: "violet",
    isCurrency: true
  }))), activePage === 1 && /*#__PURE__*/React.createElement(CollapsibleSection, {
    title: "ESTAT\xCDSTICAS",
    defaultOpen: false,
    globalTrigger: expandTrigger,
    globalState: globalExpandState
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap justify-between items-center gap-2 mb-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800 uppercase"
  }, "Valor Empenhado e QTD por Gestor"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("select", {
    value: gestorChartSort,
    onChange: e => setGestorChartSort(e.target.value),
    className: "text-[9px] font-bold uppercase border border-slate-300 bg-slate-50 rounded px-2 py-1 outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: "qtd_tit"
  }, "QTD Titular"), /*#__PURE__*/React.createElement("option", {
    value: "qtd_sub"
  }, "QTD Substituto"), /*#__PURE__*/React.createElement("option", {
    value: "emp_tit"
  }, "Emp Titular"), /*#__PURE__*/React.createElement("option", {
    value: "emp_sub"
  }, "Emp Substituto"), /*#__PURE__*/React.createElement("option", {
    value: "nome_asc"
  }, "A-Z")), /*#__PURE__*/React.createElement(ChartTableToggle, {
    isTable: chartTableViews.gestor,
    onToggle: () => toggleChartTableView('gestor')
  }))), /*#__PURE__*/React.createElement("div", {
    className: "h-[360px]"
  }, chartTableViews.gestor ? /*#__PURE__*/React.createElement(SortableChartTable, {
    id: "Tabela_Gestor",
    title: "Valor Empenhado e QTD por Gestor",
    rows: gestorTableRows,
    columns: personTableColumns('GESTOR'),
    initialSortKey: "emp_total"
  }) : /*#__PURE__*/React.createElement(ChartComponent, {
    id: "gGestor",
    type: "bar",
    data: {
      labels: gestorDataProcessed.map(d => formatLabelMultiLine(d.label)),
      datasets: [{
        label: 'QTD Titular',
        data: gestorDataProcessed.map(d => d.qtd_tit),
        backgroundColor: '#eab308',
        xAxisID: 'x1',
        stack: 'StackQtd',
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          anchor: 'center',
          align: 'center',
          rotation: 0,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'QTD Substituto',
        data: gestorDataProcessed.map(d => d.qtd_sub),
        backgroundColor: '#fde047',
        xAxisID: 'x1',
        stack: 'StackQtd',
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          anchor: 'center',
          align: 'center',
          rotation: 0,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Emp. Titular',
        data: gestorDataProcessed.map(d => d.emp_tit),
        backgroundColor: '#3b82f6',
        xAxisID: 'x',
        stack: 'StackEmp',
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          anchor: 'center',
          align: 'center',
          rotation: 0,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Emp. Substituto',
        data: gestorDataProcessed.map(d => d.emp_sub),
        backgroundColor: '#93c5fd',
        xAxisID: 'x',
        stack: 'StackEmp',
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          anchor: 'center',
          align: 'center',
          rotation: 0,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: tooltipCallback,
        customLinePlugin: {
          x: 20,
          scaleID: 'x1'
        },
        datalabels: {
          display: true
        },
        legend: {
          labels: {
            font: {
              size: 9
            },
            boxWidth: 10
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            callback: v => shortenNumber(v)
          }
        },
        x1: {
          stacked: true,
          position: 'top',
          grid: {
            display: false
          }
        },
        y: {
          stacked: true
        }
      }
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap justify-between items-center gap-2 mb-4"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800 uppercase"
  }, "Valor Empenhado e QTD por Fiscal"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("select", {
    value: fiscalChartSort,
    onChange: e => setFiscalChartSort(e.target.value),
    className: "text-[9px] font-bold uppercase border border-slate-300 bg-slate-50 rounded px-2 py-1 outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: "qtd_tit"
  }, "QTD Titular"), /*#__PURE__*/React.createElement("option", {
    value: "qtd_sub"
  }, "QTD Substituto"), /*#__PURE__*/React.createElement("option", {
    value: "emp_tit"
  }, "Emp Titular"), /*#__PURE__*/React.createElement("option", {
    value: "emp_sub"
  }, "Emp Substituto"), /*#__PURE__*/React.createElement("option", {
    value: "nome_asc"
  }, "A-Z")), /*#__PURE__*/React.createElement(ChartTableToggle, {
    isTable: chartTableViews.fiscal,
    onToggle: () => toggleChartTableView('fiscal')
  }))), /*#__PURE__*/React.createElement("div", {
    className: "h-[360px]"
  }, chartTableViews.fiscal ? /*#__PURE__*/React.createElement(SortableChartTable, {
    id: "Tabela_Fiscal",
    title: "Valor Empenhado e QTD por Fiscal",
    rows: fiscalTableRows,
    columns: personTableColumns('FISCAL'),
    initialSortKey: "emp_total"
  }) : /*#__PURE__*/React.createElement(ChartComponent, {
    id: "gFiscal",
    type: "bar",
    data: {
      labels: fiscalDataProcessed.map(d => formatLabelMultiLine(d.label)),
      datasets: [{
        label: 'QTD Titular',
        data: fiscalDataProcessed.map(d => d.qtd_tit),
        backgroundColor: '#eab308',
        xAxisID: 'x1',
        stack: 'StackQtd',
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          anchor: 'center',
          align: 'center',
          rotation: 0,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'QTD Substituto',
        data: fiscalDataProcessed.map(d => d.qtd_sub),
        backgroundColor: '#fde047',
        xAxisID: 'x1',
        stack: 'StackQtd',
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          anchor: 'center',
          align: 'center',
          rotation: 0,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Emp. Titular',
        data: fiscalDataProcessed.map(d => d.emp_tit),
        backgroundColor: '#3b82f6',
        xAxisID: 'x',
        stack: 'StackEmp',
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          anchor: 'center',
          align: 'center',
          rotation: 0,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Emp. Substituto',
        data: fiscalDataProcessed.map(d => d.emp_sub),
        backgroundColor: '#93c5fd',
        xAxisID: 'x',
        stack: 'StackEmp',
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          anchor: 'center',
          align: 'center',
          rotation: 0,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: tooltipCallback,
        customLinePlugin: {
          x: 10,
          scaleID: 'x1'
        },
        datalabels: {
          display: true
        },
        legend: {
          labels: {
            font: {
              size: 9
            },
            boxWidth: 10
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            callback: v => shortenNumber(v)
          }
        },
        x1: {
          stacked: true,
          position: 'top',
          grid: {
            display: false
          }
        },
        y: {
          stacked: true
        }
      }
    }
  })))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "md:col-span-2 text-center text-sm font-black text-slate-700 uppercase tracking-widest"
  }, "Modalidade"), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pModV",
    title: "Empenhado (Mod)",
    data: modData,
    isFinancial: true
  }), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pModQ",
    title: "QTD Contratos (Mod)",
    data: modData,
    isFinancial: false
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "md:col-span-2 text-center text-sm font-black text-slate-700 uppercase tracking-widest"
  }, "Se\xE7\xE3o Log\xEDstica"), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pSecV",
    title: "Empenhado (SEC)",
    data: secData,
    isFinancial: true
  }), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pSecQ",
    title: "QTD Contratos (SEC)",
    data: secData,
    isFinancial: false
  }))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "md:col-span-2 text-center text-sm font-black text-slate-700 uppercase tracking-widest"
  }, "N\xFAmero da Compra"), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pCompV",
    title: "Empenhado (Nr Compra)",
    data: compraData,
    isFinancial: true
  }), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pCompQ",
    title: "QTD Contratos (Nr Compra)",
    data: compraData,
    isFinancial: false
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "md:col-span-2 text-center text-sm font-black text-slate-700 uppercase tracking-widest"
  }, "Fornecedor"), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pFornV",
    title: "Empenhado (Fornecedor)",
    data: fornData,
    isFinancial: true,
    isFornecedor: true
  }), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pFornQ",
    title: "QTD Contratos (Fornecedor)",
    data: fornData,
    isFinancial: false,
    isFornecedor: true
  }))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto grid grid-cols-1 xl:grid-cols-2 gap-6 mb-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "md:col-span-2 text-center text-sm font-black text-slate-700 uppercase tracking-widest"
  }, "Ano de In\xEDcio da Vig\xEAncia"), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pAnoVigV",
    title: "Empenhado (Ano Vig Ini)",
    data: anoVigIniData,
    isFinancial: true
  }), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pAnoVigQ",
    title: "QTD Contratos (Ano Vig Ini)",
    data: anoVigIniData,
    isFinancial: false
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "md:col-span-2 text-center text-sm font-black text-slate-700 uppercase tracking-widest"
  }, "Situa\xE7\xE3o"), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pSitV",
    title: "Empenhado (Situa\xE7\xE3o)",
    data: situacaoData,
    isFinancial: true
  }), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pSitQ",
    title: "QTD Contratos (Situa\xE7\xE3o)",
    data: situacaoData,
    isFinancial: false
  }))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto grid grid-cols-1 xl:grid-cols-2 gap-6 mb-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "md:col-span-2 text-center text-sm font-black text-slate-700 uppercase tracking-widest"
  }, "AO C\xF3digo"), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pAoCodigoV",
    title: "Empenhado (AO C\xF3digo)",
    data: aoCodigoData,
    isFinancial: true
  }), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pAoCodigoQ",
    title: "QTD Contratos (AO C\xF3digo)",
    data: aoCodigoData,
    isFinancial: false
  })), /*#__PURE__*/React.createElement("div", {
    className: "grid grid-cols-1 md:grid-cols-2 gap-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "md:col-span-2 text-center text-sm font-black text-slate-700 uppercase tracking-widest"
  }, "ND C\xF3digo"), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pNdCodigoV",
    title: "Empenhado (ND C\xF3digo)",
    data: ndCodigoData,
    isFinancial: true
  }), /*#__PURE__*/React.createElement(ToggleableChartCard, {
    id: "pNdCodigoQ",
    title: "QTD Contratos (ND C\xF3digo)",
    data: ndCodigoData,
    isFinancial: false
  })))), activePage === 2 && /*#__PURE__*/React.createElement(CollapsibleSection, {
    title: "GR\xC1FICOS DE EXECU\xC7\xC3O",
    defaultOpen: false,
    globalTrigger: expandTrigger,
    globalState: globalExpandState
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto mb-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center mb-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800 uppercase"
  }, "EXECU\xC7\xC3O OR\xC7AMENT\xC1RIA E QTD (TOP 20)"), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2 items-center"
  }, /*#__PURE__*/React.createElement("select", {
    value: top20Sort,
    onChange: e => setTop20Sort(e.target.value),
    className: "text-[10px] font-bold uppercase border border-slate-300 bg-slate-50 rounded px-2 py-1 outline-none"
  }, renderTop20SortOptions()), /*#__PURE__*/React.createElement("select", {
    value: top20ViewMode,
    onChange: e => setTop20ViewMode(e.target.value),
    className: "text-[9px] font-black uppercase tracking-widest bg-blue-50 text-blue-600 px-3 py-1.5 rounded border border-blue-200 hover:bg-blue-100 transition shadow-sm cursor-pointer outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: "fornecedor"
  }, "VER POR FORNECEDOR"), /*#__PURE__*/React.createElement("option", {
    value: "contrato"
  }, "VER POR CONTRATO"), /*#__PURE__*/React.createElement("option", {
    value: "empenho"
  }, "VER POR EMPENHO"), /*#__PURE__*/React.createElement("option", {
    value: "ano"
  }, "VER POR ANO"), /*#__PURE__*/React.createElement("option", {
    value: "modalidade"
  }, "VER POR MODALIDADE"), /*#__PURE__*/React.createElement("option", {
    value: "sec_log"
  }, "VER POR SEC LOG"), /*#__PURE__*/React.createElement("option", {
    value: "ao_codigo"
  }, "VER POR AO C\xD3DIGO"), /*#__PURE__*/React.createElement("option", {
    value: "nd_codigo"
  }, "VER POR ND C\xD3DIGO"), /*#__PURE__*/React.createElement("option", {
    value: "pi_codigo"
  }, "VER POR PI C\xD3DIGO")), /*#__PURE__*/React.createElement(ChartTableToggle, {
    isTable: chartTableViews.top20,
    onToggle: () => toggleChartTableView('top20')
  }))), /*#__PURE__*/React.createElement("div", {
    className: "h-[400px]"
  }, chartTableViews.top20 ? /*#__PURE__*/React.createElement(SortableChartTable, {
    id: "Tabela_Execucao_Orcamentaria_Top20",
    title: "EXECU\xC7\xC3O OR\xC7AMENT\xC1RIA E QTD (TOP 20)",
    rows: top20TableRows,
    columns: top20TableColumns,
    initialSortKey: "total"
  }) : /*#__PURE__*/React.createElement(ChartComponent, {
    id: "gTop20",
    type: "bar",
    exportRows: top20TableRows.slice(0, 20),
    exportColumns: top20TableColumns,
    data: {
      labels: top20DataProcessed.map(d => formatLabelMultiLine(top20ViewMode === 'fornecedor' ? d.label.replace(/^[\d\.\-\/]+\s*-\s*/, '') : d.label)),
      datasets: [{
        label: 'QTD Contratos',
        data: top20DataProcessed.map(d => d.count),
        backgroundColor: '#8b5cf6',
        borderColor: '#8b5cf6',
        yAxisID: 'y1',
        type: 'line',
        borderWidth: 2,
        pointRadius: 4,
        order: 1,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          rotation: -90,
          align: 'bottom',
          anchor: 'start',
          font: {
            size: 9,
            weight: 'bold'
          }
        }
      }, {
        label: 'Empenhado',
        data: top20DataProcessed.map(d => d.total),
        backgroundColor: '#3b82f6',
        yAxisID: 'y',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          rotation: -90,
          align: 'start',
          anchor: 'end',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Recebido',
        data: top20DataProcessed.map(d => d.recebido),
        backgroundColor: '#06b6d4',
        yAxisID: 'y',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          rotation: -90,
          align: 'start',
          anchor: 'end',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Liquidado',
        data: top20DataProcessed.map(d => d.liquidado),
        backgroundColor: '#f59e0b',
        yAxisID: 'y',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          rotation: -90,
          align: 'start',
          anchor: 'end',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Pago',
        data: top20DataProcessed.map(d => d.pago),
        backgroundColor: '#10b981',
        yAxisID: 'y',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          rotation: -90,
          align: 'start',
          anchor: 'end',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Bloqueado',
        data: top20DataProcessed.map(d => d.bloqueado),
        backgroundColor: '#f97316',
        yAxisID: 'y',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          rotation: -90,
          align: 'start',
          anchor: 'end',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'Cancelado',
        data: top20DataProcessed.map(d => d.cancelado),
        backgroundColor: '#ef4444',
        yAxisID: 'y',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          rotation: -90,
          align: 'start',
          anchor: 'end',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'A Liquidar',
        data: top20DataProcessed.map(d => Math.max(0, d.a_liquidar)),
        backgroundColor: '#cbd5e1',
        yAxisID: 'y',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          rotation: -90,
          align: 'start',
          anchor: 'end',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }, {
        label: 'A Pagar',
        data: top20DataProcessed.map(d => Math.max(0, d.a_pagar)),
        backgroundColor: '#94a3b8',
        yAxisID: 'y',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          rotation: -90,
          align: 'start',
          anchor: 'end',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }]
    },
    options: {
      indexAxis: 'x',
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        tooltip: {
          callbacks: {
            title: function (context) {
              return context[0].label;
            },
            beforeBody: function (context) {
              const idx = context[0].dataIndex;
              const item = top20DataProcessed[idx];
              if (top20ViewMode === 'contrato') return `Fornecedor: ${item.fornecedor}`;
              return '';
            },
            label: function (context) {
              let label = context.dataset.label || '';
              if (label) label += ': ';
              if (context.dataset.yAxisID === 'y1' || label.includes('QTD')) {
                label += context.raw.toLocaleString('pt-BR');
              } else {
                label += formatBRL(context.raw);
              }
              return label;
            }
          }
        },
        datalabels: {
          display: false
        },
        legend: {
          position: 'top',
          labels: {
            boxWidth: 10,
            font: {
              size: 9
            },
            sort: (a, b) => ['QTD Contratos', 'Empenhado', 'Recebido', 'Liquidado', 'Pago', 'Bloqueado', 'Cancelado', 'A Liquidar', 'A Pagar'].indexOf(a.text) - ['QTD Contratos', 'Empenhado', 'Recebido', 'Liquidado', 'Pago', 'Bloqueado', 'Cancelado', 'A Liquidar', 'A Pagar'].indexOf(b.text)
          }
        }
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 90,
            minRotation: 45,
            font: {
              size: 9,
              weight: 'bold'
            },
            autoSkip: false
          }
        },
        y: {
          position: 'left',
          ticks: {
            callback: v => shortenNumber(v)
          },
          title: {
            display: true,
            text: 'Valores (R$)',
            font: {
              size: 8
            }
          }
        },
        y1: {
          position: 'right',
          grid: {
            display: false
          },
          title: {
            display: true,
            text: 'Quantidade',
            font: {
              size: 8
            }
          }
        }
      }
    }
  })))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto mb-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center mb-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800 uppercase"
  }, "EXECU\xC7\xC3O OR\xC7AMENT\xC1RIA E QTD EM 100 % (TOP 20)"), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2 items-center"
  }, /*#__PURE__*/React.createElement("select", {
    value: top20100Sort,
    onChange: e => setTop20100Sort(e.target.value),
    className: "text-[10px] font-bold uppercase border border-slate-300 bg-slate-50 rounded px-2 py-1 outline-none"
  }, renderTop20SortOptions()), /*#__PURE__*/React.createElement("select", {
    value: top20100ViewMode,
    onChange: e => setTop20100ViewMode(e.target.value),
    className: "text-[9px] font-black uppercase tracking-widest bg-blue-50 text-blue-600 px-3 py-1.5 rounded border border-blue-200 hover:bg-blue-100 transition shadow-sm cursor-pointer outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: "fornecedor"
  }, "VER POR FORNECEDOR"), /*#__PURE__*/React.createElement("option", {
    value: "contrato"
  }, "VER POR CONTRATO"), /*#__PURE__*/React.createElement("option", {
    value: "empenho"
  }, "VER POR EMPENHO"), /*#__PURE__*/React.createElement("option", {
    value: "ano"
  }, "VER POR ANO"), /*#__PURE__*/React.createElement("option", {
    value: "modalidade"
  }, "VER POR MODALIDADE"), /*#__PURE__*/React.createElement("option", {
    value: "sec_log"
  }, "VER POR SEC LOG"), /*#__PURE__*/React.createElement("option", {
    value: "ao_codigo"
  }, "VER POR AO C\xD3DIGO"), /*#__PURE__*/React.createElement("option", {
    value: "nd_codigo"
  }, "VER POR ND C\xD3DIGO"), /*#__PURE__*/React.createElement("option", {
    value: "pi_codigo"
  }, "VER POR PI C\xD3DIGO")), /*#__PURE__*/React.createElement(ChartTableToggle, {
    isTable: chartTableViews.top20100,
    onToggle: () => toggleChartTableView('top20100')
  }))), /*#__PURE__*/React.createElement("div", {
    className: "h-[400px]"
  }, chartTableViews.top20100 ? /*#__PURE__*/React.createElement(SortableChartTable, {
    id: "Tabela_Execucao_Orcamentaria_100_Top20",
    title: "EXECU\xC7\xC3O OR\xC7AMENT\xC1RIA E QTD EM 100 % (TOP 20)",
    rows: top20100TableRows,
    columns: top20100TableColumns,
    initialSortKey: "total"
  }) : /*#__PURE__*/React.createElement(ChartComponent, {
    id: "gTop20100",
    type: "bar",
    exportRows: top20100TableRows.slice(0, 20),
    exportColumns: top20100TableColumns,
    data: {
      labels: top20100DataProcessed.map(d => formatLabelMultiLine(top20100ViewMode === 'fornecedor' ? d.label.replace(/^[\d\.\-\/]+\s*-\s*/, '') : d.label)),
      datasets: [{
        label: 'QTD Contratos',
        data: top20100DataProcessed.map(d => d.count),
        backgroundColor: '#8b5cf6',
        borderColor: '#8b5cf6',
        type: 'line',
        borderWidth: 2,
        pointRadius: 4,
        xAxisID: 'x',
        yAxisID: 'y1',
        order: 1,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          rotation: -90,
          align: 'bottom',
          anchor: 'start',
          font: {
            size: 9,
            weight: 'bold'
          }
        }
      }, {
        label: 'Empenhado (100 %)',
        data: top20100DataProcessed.map(d => 100),
        backgroundColor: 'transparent',
        borderColor: '#3b82f6',
        borderWidth: 2,
        xAxisID: 'x',
        yAxisID: 'y',
        grouped: false,
        stack: '2',
        order: 3,
        datalabels: {
          display: false
        }
      }, {
        label: 'Recebido %',
        data: top20100DataProcessed.map(d => d.p_recebido * 100),
        backgroundColor: 'transparent',
        borderColor: '#06b6d4',
        borderWidth: {
          top: 4,
          right: 0,
          bottom: 0,
          left: 0
        },
        xAxisID: 'x',
        yAxisID: 'y',
        grouped: false,
        stack: '3',
        order: 2,
        datalabels: {
          display: false
        }
      },
      // Fundo / Stack de Componentes da Despesa (Somam 100% do Empenho) - Agrupados juntos e com Z-index mais baixo
      {
        label: 'Liquidado %',
        data: top20100DataProcessed.map(d => d.total ? d.liquidado / d.total * 100 : 0),
        backgroundColor: '#f59e0b',
        xAxisID: 'x',
        yAxisID: 'y',
        grouped: false,
        stack: '1',
        order: 4,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] >= 4;
          },
          color: '#fff',
          rotation: -90,
          align: 'center',
          anchor: 'center',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => `${v.toFixed(1).replace('.', ',')}%`
        }
      }, {
        label: 'A Liquidar %',
        data: top20100DataProcessed.map(d => d.p_a_liquidar * 100),
        backgroundColor: '#cbd5e1',
        xAxisID: 'x',
        yAxisID: 'y',
        grouped: false,
        stack: '1',
        order: 4,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] >= 4;
          },
          color: '#1e293b',
          rotation: -90,
          align: 'center',
          anchor: 'center',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => `${v.toFixed(1).replace('.', ',')}%`
        }
      }, {
        label: 'Pago %',
        data: top20100DataProcessed.map(d => d.p_pago * 100),
        backgroundColor: 'transparent',
        borderColor: '#111827',
        borderWidth: {
          top: 4,
          right: 0,
          bottom: 0,
          left: 0
        },
        xAxisID: 'x',
        yAxisID: 'y',
        grouped: false,
        stack: '4',
        order: 2,
        datalabels: {
          display: false
        }
      }, {
        label: 'Bloqueado %',
        data: top20100DataProcessed.map(d => d.total ? d.bloqueado / d.total * 100 : 0),
        backgroundColor: '#f97316',
        xAxisID: 'x',
        yAxisID: 'y',
        grouped: false,
        stack: '1',
        order: 4,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] >= 4;
          },
          color: '#fff',
          rotation: -90,
          align: 'center',
          anchor: 'center',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => `${v.toFixed(1).replace('.', ',')}%`
        }
      }, {
        label: 'Cancelado %',
        data: top20100DataProcessed.map(d => d.total ? d.cancelado / d.total * 100 : 0),
        backgroundColor: '#ef4444',
        xAxisID: 'x',
        yAxisID: 'y',
        grouped: false,
        stack: '1',
        order: 4,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] >= 4;
          },
          color: '#fff',
          rotation: -90,
          align: 'center',
          anchor: 'center',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => `${v.toFixed(1).replace('.', ',')}%`
        }
      }]
    },
    options: {
      indexAxis: 'x',
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        fiftyPercentLinePlugin: {
          display: true
        },
        tooltip: {
          callbacks: {
            title: function (context) {
              return context[0].label;
            },
            beforeBody: function (context) {
              const idx = context[0].dataIndex;
              const item = top20100DataProcessed[idx];
              if (top20100ViewMode === 'contrato') return `Fornecedor: ${item.fornecedor}`;
              return '';
            },
            label: function (context) {
              if (context.dataset.yAxisID === 'y1') return context.dataset.label + ': ' + context.raw;
              const label = context.dataset.label;
              const rawVal = context.raw;
              const percentStr = rawVal.toFixed(1).replace('.', ',') + '%';
              const idx = context.dataIndex;
              const d = top20100DataProcessed[idx];
              let absVal = 0;
              if (label.includes('Recebido')) absVal = d.recebido;else if (label.includes('Liquidado')) absVal = d.liquidado;else if (label.includes('A Liquidar')) absVal = Math.max(0, d.a_liquidar);else if (label.includes('Pago')) absVal = d.pago;else if (label.includes('Bloqueado')) absVal = d.bloqueado;else if (label.includes('Cancelado')) absVal = d.cancelado;else if (label.includes('Empenhado')) absVal = d.total;
              const cleanLabel = label === 'Empenhado (100 %)' ? 'Empenhado' : label.replace(/ %$/, '');
              return label === 'Empenhado (100 %)' ? `${cleanLabel}: ${formatBRL(absVal)}` : `${cleanLabel}: ${formatBRL(absVal)} (${percentStr})`;
            },
            afterBody: function (context) {
              const d = top20100DataProcessed[context[0].dataIndex];
              return `A Pagar: ${formatBRL(Math.max(0, d.a_pagar))} (${formatPercentBR(d.p_a_pagar)})`;
            }
          }
        },
        datalabels: {
          display: true
        },
        legend: {
          position: 'top',
          labels: {
            boxWidth: 10,
            font: {
              size: 9
            },
            sort: (a, b) => ['QTD Contratos', 'Empenhado (100 %)', 'Recebido %', 'Liquidado %', 'A Liquidar %', 'Pago %', 'Bloqueado %', 'Cancelado %'].indexOf(a.text) - ['QTD Contratos', 'Empenhado (100 %)', 'Recebido %', 'Liquidado %', 'A Liquidar %', 'Pago %', 'Bloqueado %', 'Cancelado %'].indexOf(b.text)
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            maxRotation: 90,
            minRotation: 45,
            font: {
              size: 9,
              weight: 'bold'
            },
            autoSkip: false
          }
        },
        y: {
          stacked: true,
          position: 'left',
          min: 0,
          max: 105,
          ticks: {
            callback: v => v + '%'
          },
          title: {
            display: true,
            text: 'Percentual (%)',
            font: {
              size: 8
            }
          }
        },
        y1: {
          display: true,
          position: 'right',
          grid: {
            display: false
          },
          title: {
            display: true,
            text: 'Quantidade',
            font: {
              size: 8
            }
          },
          grace: '10%',
          beginAtZero: true
        }
      }
    }
  })))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto mb-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "mb-6 flex items-center justify-between gap-2"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800 uppercase"
  }, "Contratos Iniciados/Encerrados por Ano e Valor Empenhado"), /*#__PURE__*/React.createElement(ChartTableToggle, {
    isTable: chartTableViews.ano,
    onToggle: () => toggleChartTableView('ano')
  })), /*#__PURE__*/React.createElement("div", {
    className: "h-[400px]"
  }, chartTableViews.ano ? /*#__PURE__*/React.createElement(SortableChartTable, {
    id: "Tabela_Contratos_por_Ano",
    title: "Contratos Iniciados/Encerrados por Ano e Valor Empenhado",
    rows: yearTableRows,
    columns: yearTableColumns,
    initialSortKey: "label"
  }) : /*#__PURE__*/React.createElement(ChartComponent, {
    id: "gAno",
    type: "bar",
    data: {
      labels: dataByAno.map(d => d.label),
      datasets: [{
        label: 'Contratos Iniciados',
        data: dataByAno.map(d => d.iniciados),
        backgroundColor: '#22c55e',
        yAxisID: 'y_qtd',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          anchor: 'end',
          align: 'start',
          rotation: -90,
          font: {
            family: 'Outfit',
            size: 10,
            weight: 'bold'
          },
          formatter: v => v
        }
      }, {
        label: 'Contratos Encerrados',
        data: dataByAno.map(d => d.encerrados),
        backgroundColor: '#ef4444',
        yAxisID: 'y_qtd',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          anchor: 'end',
          align: 'start',
          rotation: -90,
          font: {
            family: 'Outfit',
            size: 10,
            weight: 'bold'
          },
          formatter: v => v
        }
      }, {
        label: 'Contratos Durante',
        data: dataByAno.map(d => d.durante),
        backgroundColor: '#8b5cf6',
        yAxisID: 'y_qtd',
        borderRadius: 4,
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#1e293b',
          anchor: 'end',
          align: 'start',
          rotation: -90,
          font: {
            family: 'Outfit',
            size: 10,
            weight: 'bold'
          },
          formatter: v => v
        }
      }, {
        label: 'Valor Empenhado (Iniciados)',
        data: dataByAno.map(d => d.empenhado),
        backgroundColor: '#3b82f6',
        borderColor: '#3b82f6',
        yAxisID: 'y_val',
        type: 'line',
        borderWidth: 3,
        tension: 0.3,
        pointRadius: 5,
        order: 1,
        datalabels: {
          display: true,
          color: '#1e3a8a',
          anchor: 'end',
          align: 'bottom',
          rotation: -90,
          font: {
            family: 'Outfit',
            size: 10,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }]
    },
    options: {
      indexAxis: 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            label: function (context) {
              let val = context.raw;
              if (context.dataset.yAxisID === 'y_val') return context.dataset.label + ': ' + formatBRL(val);
              return context.dataset.label + ': ' + val.toLocaleString('pt-BR');
            }
          }
        },
        datalabels: {
          display: false
        },
        legend: {
          position: 'top',
          labels: {
            boxWidth: 10,
            font: {
              size: 9
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 90,
            minRotation: 0,
            font: {
              size: 10,
              weight: 'bold'
            },
            autoSkip: false
          }
        },
        y_qtd: {
          type: 'linear',
          position: 'left',
          title: {
            display: true,
            text: 'Quantidade',
            font: {
              weight: 'bold'
            }
          },
          grace: '10%',
          beginAtZero: true
        },
        y_val: {
          type: 'linear',
          position: 'right',
          grid: {
            display: false
          },
          ticks: {
            callback: v => shortenNumber(v)
          },
          title: {
            display: true,
            text: 'Valor Empenhado (R$)',
            font: {
              weight: 'bold'
            }
          },
          grace: '10%',
          beginAtZero: true
        }
      }
    }
  })))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto mb-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-center mb-6"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800 uppercase"
  }, "Desempenho e Empenho por Contrato (Top 20)"), /*#__PURE__*/React.createElement("div", {
    className: "flex items-center gap-2"
  }, /*#__PURE__*/React.createElement("select", {
    value: contratoSort,
    onChange: e => setContratoSort(e.target.value),
    className: "text-[10px] font-bold uppercase border border-slate-300 bg-slate-50 rounded px-2 py-1 outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: "dias_asc"
  }, "Menos dias restantes"), /*#__PURE__*/React.createElement("option", {
    value: "dias_desc"
  }, "Mais dias restantes"), /*#__PURE__*/React.createElement("option", {
    value: "recebido_desc"
  }, "% Recebido"), /*#__PURE__*/React.createElement("option", {
    value: "liquidado_desc"
  }, "% Liquidado"), /*#__PURE__*/React.createElement("option", {
    value: "pago_desc"
  }, "% Pago")), /*#__PURE__*/React.createElement(ChartTableToggle, {
    isTable: chartTableViews.contrato,
    onToggle: () => toggleChartTableView('contrato')
  }))), /*#__PURE__*/React.createElement("div", {
    className: "h-[400px]"
  }, chartTableViews.contrato ? /*#__PURE__*/React.createElement(SortableChartTable, {
    id: "Tabela_Desempenho_Contrato_Top20",
    title: "Desempenho e Empenho por Contrato (Top 20)",
    rows: contractTableRows,
    columns: contractTableColumns,
    initialSortKey: "v_empenhado"
  }) : /*#__PURE__*/React.createElement(ChartComponent, {
    id: "gContrato",
    type: "bar",
    exportRows: contractTableRows.slice(0, 20),
    exportColumns: contractTableColumns,
    data: {
      labels: contratoChartData.map(d => formatLabelMultiLine(d.contrato)),
      datasets: [{
        label: '% Tempo',
        data: contratoChartData.map(d => d.perc_tempo),
        borderColor: '#ec4899',
        backgroundColor: '#ec4899',
        yAxisID: 'y_perc',
        type: 'line',
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 4,
        order: 1,
        datalabels: {
          display: true,
          color: '#be185d',
          anchor: 'end',
          align: 'top',
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => formatPercentBR(v)
        }
      }, {
        label: '% Recebido',
        data: contratoChartData.map(d => d.p_recebido),
        backgroundColor: '#8b5cf6',
        yAxisID: 'y_perc',
        borderRadius: 4,
        type: 'bar',
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          anchor: 'end',
          align: 'start',
          rotation: 90,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => formatPercentBR(v)
        }
      }, {
        label: '% Liquidado',
        data: contratoChartData.map(d => d.p_liquidado),
        backgroundColor: '#f59e0b',
        yAxisID: 'y_perc',
        borderRadius: 4,
        type: 'bar',
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          anchor: 'end',
          align: 'start',
          rotation: 90,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => formatPercentBR(v)
        }
      }, {
        label: '% Pago',
        data: contratoChartData.map(d => d.p_pago),
        backgroundColor: '#10b981',
        yAxisID: 'y_perc',
        borderRadius: 4,
        type: 'bar',
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          anchor: 'end',
          align: 'start',
          rotation: 90,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => formatPercentBR(v)
        }
      }, {
        label: 'Valor Empenhado',
        data: contratoChartData.map(d => d.v_empenhado),
        backgroundColor: '#06b6d4',
        yAxisID: 'y_val',
        borderRadius: 4,
        type: 'bar',
        order: 2,
        datalabels: {
          display: function (ctx) {
            return ctx.dataset.data[ctx.dataIndex] > 0;
          },
          color: '#fff',
          anchor: 'end',
          align: 'start',
          rotation: 90,
          font: {
            size: 9,
            weight: 'bold'
          },
          formatter: v => shortenNumber(v)
        }
      }]
    },
    options: {
      indexAxis: 'x',
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        tooltip: getFullTooltipContrato(contratoChartData),
        datalabels: {
          display: false
        },
        legend: {
          position: 'top',
          labels: {
            boxWidth: 10,
            font: {
              size: 9
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            maxRotation: 90,
            minRotation: 45,
            font: {
              size: 9,
              weight: 'bold'
            },
            autoSkip: false
          }
        },
        y_perc: {
          type: 'linear',
          position: 'left',
          ticks: {
            callback: v => (v * 100).toFixed(0) + '%'
          },
          grace: '10%',
          beginAtZero: true
        },
        y_val: {
          type: 'linear',
          position: 'right',
          grid: {
            display: false
          },
          ticks: {
            callback: v => shortenNumber(v)
          },
          grace: '10%',
          beginAtZero: true
        }
      }
    }
  })))), /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto mb-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-white p-6 rounded-2xl shadow-sm border border-slate-200"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex justify-between items-start mb-6"
  }, /*#__PURE__*/React.createElement("div", {
    className: "flex flex-col gap-2"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-xs font-black text-slate-800 uppercase"
  }, "Correla\xE7\xE3o: ", scatterMetricLabels[scatterXAxis], " vs % Tempo (Tamanho da bolha: Empenhado)"), /*#__PURE__*/React.createElement("div", {
    className: "flex flex-wrap gap-2"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bg-slate-100 text-slate-600 px-2 py-1 rounded text-[9px] font-bold border border-slate-200"
  }, "NORMAL (Q1): ", q1Normal, " (", pQ1, ")"), /*#__PURE__*/React.createElement("span", {
    className: "bg-red-50 text-red-600 px-2 py-1 rounded text-[9px] font-bold border border-red-200"
  }, "RUIM (Q2): ", q2Ruim, " (", pQ2, ")"), /*#__PURE__*/React.createElement("span", {
    className: "bg-slate-100 text-slate-600 px-2 py-1 rounded text-[9px] font-bold border border-slate-200"
  }, "NORMAL (Q3): ", q3Normal, " (", pQ3, ")"), /*#__PURE__*/React.createElement("span", {
    className: "bg-green-50 text-green-600 px-2 py-1 rounded text-[9px] font-bold border border-green-200"
  }, "\xD3TIMO (Q4): ", q4Otimo, " (", pQ4, ")"))), /*#__PURE__*/React.createElement("div", {
    className: "mt-1 flex shrink-0 items-center gap-2"
  }, /*#__PURE__*/React.createElement("select", {
    value: scatterXAxis,
    onChange: e => setScatterXAxis(e.target.value),
    className: "text-[10px] font-bold uppercase border border-slate-300 bg-slate-50 rounded px-3 py-1.5 outline-none"
  }, /*#__PURE__*/React.createElement("option", {
    value: "p_recebido"
  }, "% Recebido"), /*#__PURE__*/React.createElement("option", {
    value: "p_liquidado"
  }, "% Liquidado"), /*#__PURE__*/React.createElement("option", {
    value: "p_pago"
  }, "% Pago"), /*#__PURE__*/React.createElement("option", {
    value: "p_executado"
  }, "% Executado")), /*#__PURE__*/React.createElement(ChartTableToggle, {
    isTable: chartTableViews.correlacao,
    onToggle: () => toggleChartTableView('correlacao')
  }))), /*#__PURE__*/React.createElement("div", {
    className: "h-[450px]"
  }, chartTableViews.correlacao ? /*#__PURE__*/React.createElement(SortableChartTable, {
    id: "Tabela_Correlacao_Execucao_Tempo",
    title: `Correlação: ${scatterMetricLabels[scatterXAxis]} vs % Tempo`,
    rows: scatterTableRows,
    columns: scatterTableColumns,
    initialSortKey: "v_empenhado"
  }) : /*#__PURE__*/React.createElement(ChartComponent, {
    id: "gScatter",
    type: "bubble",
    data: {
      datasets: [{
        label: 'Contratos',
        data: bubbleData,
        backgroundColor: context => context.raw ? context.raw.color : 'rgba(14, 165, 233, 0.6)',
        borderColor: '#ffffff',
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: getBubbleTooltip(),
        datalabels: {
          display: false
        },
        legend: {
          display: false
        },
        scatterQuadrantPlugin: {
          display: true
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: scatterMetricLabels[scatterXAxis],
            font: {
              weight: 'bold'
            }
          },
          min: -10,
          max: 110,
          ticks: {
            callback: function (value) {
              if (value >= 0 && value <= 100) return value + '%';
              return null;
            }
          },
          grid: {
            color: context => [0, 100].includes(Number(context.tick.value)) ? '#f97316' : 'rgba(203, 213, 225, 0.55)',
            lineWidth: context => [0, 100].includes(Number(context.tick.value)) ? 2 : 1
          }
        },
        y: {
          title: {
            display: true,
            text: '% Tempo',
            font: {
              weight: 'bold'
            }
          },
          min: -10,
          max: 110,
          ticks: {
            callback: function (value) {
              if (value >= 0 && value <= 100) return value + '%';
              return null;
            }
          },
          grid: {
            color: context => [0, 100].includes(Number(context.tick.value)) ? '#f97316' : 'rgba(203, 213, 225, 0.55)',
            lineWidth: context => [0, 100].includes(Number(context.tick.value)) ? 2 : 1
          }
        }
      }
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "mt-4 flex flex-wrap gap-3 justify-center border-t border-slate-100 pt-4"
  }, Object.keys(tagColorsMap).map(k => {
    const isHidden = scatterHiddenTags.includes(k);
    return /*#__PURE__*/React.createElement("div", {
      key: k,
      onClick: () => toggleScatterTag(k),
      className: `flex items-center gap-1 cursor-pointer transition ${isHidden ? 'opacity-30 grayscale' : 'hover:opacity-80'}`
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-3 h-3 rounded-full border border-slate-200",
      style: {
        backgroundColor: tagColorsMap[k].hex
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: `text-[9px] font-bold ${isHidden ? 'text-slate-400 line-through' : 'text-slate-600'}`
    }, k));
  })))), documentDashboard.charts), activePage === 3 && /*#__PURE__*/React.createElement(CollapsibleSection, {
    title: "TABELAS DE EXECU\xC7\xC3O",
    defaultOpen: false,
    globalTrigger: expandTrigger,
    globalState: globalExpandState
  }, /*#__PURE__*/React.createElement("div", {
    className: "max-w-[1600px] mx-auto bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden mb-10"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bg-slate-800 px-4 py-3 flex justify-between items-center flex-wrap gap-2"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "text-white text-xs font-black tracking-widest uppercase"
  }, "Detalhamento da Execu\xE7\xE3o (", kpis.qtdContratos, " Contratos \xDAnicos | Mostrando ", Math.min(100, filteredData.length), " Lan\xE7amentos)"), /*#__PURE__*/React.createElement("div", {
    className: "flex gap-2 items-center"
  }, /*#__PURE__*/React.createElement("div", {
    className: "relative"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowMasterColsMenu(!showMasterColsMenu),
    className: "text-[10px] font-black bg-slate-700 hover:bg-slate-600 text-white px-3 py-1 rounded border border-white/20 shadow transition"
  }, "COLUNAS \u25BC"), showMasterColsMenu && /*#__PURE__*/React.createElement("div", {
    className: "absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-2xl border border-slate-200 z-50 p-3 max-h-[420px] overflow-y-auto custom-scrollbar"
  }, Object.keys(masterColumnLabels).map(k => /*#__PURE__*/React.createElement("label", {
    key: k,
    className: "flex items-center gap-3 text-[11px] font-black text-slate-700 cursor-pointer hover:bg-slate-50 p-2 rounded uppercase"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: masterVisibleCols[k],
    onChange: () => setMasterVisibleCols(p => ({
      ...p,
      [k]: !p[k]
    })),
    className: "w-4 h-4 accent-blue-600 cursor-pointer"
  }), masterColumnLabels[k])))), /*#__PURE__*/React.createElement("div", {
    className: "w-[1px] h-5 bg-slate-500 mx-1 hidden sm:block"
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toExcel(filteredData, "Detalhamento_Master", getMasterExportCols()),
    className: "text-[10px] font-bold bg-green-600 text-white px-3 py-1 rounded"
  }, "EXCEL"), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toCSV(filteredData, "Detalhamento_Master", getMasterExportCols()),
    className: "text-[10px] font-bold bg-blue-600 text-white px-3 py-1 rounded"
  }, "CSV"), /*#__PURE__*/React.createElement("button", {
    onClick: () => exportTable.toPDF(filteredData, "Detalhamento_Master", getMasterExportCols(), "DETALHAMENTO DA EXECUÇÃO"),
    className: "text-[10px] font-bold bg-red-600 text-white px-3 py-1 rounded"
  }, "PDF"))), /*#__PURE__*/React.createElement("div", {
    className: "overflow-x-auto h-[600px]"
  }, /*#__PURE__*/React.createElement("table", {
    ref: financeTableRef,
    className: "finance-detail-table text-left text-[10px] border-collapse relative"
  }, /*#__PURE__*/React.createElement("thead", {
    className: "bg-slate-50 sticky top-0 border-b border-slate-200 shadow-sm z-10"
  }, /*#__PURE__*/React.createElement("tr", {
    className: "text-slate-600 uppercase font-black tracking-tighter align-top"
  }, masterVisibleCols.contrato && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-text-col w-[7%]",
    label: "CONTRATO/COMPRA",
    field: "contrato",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchContrato,
    onSearchChange: setSearchContrato
  }), masterVisibleCols.arquivos && /*#__PURE__*/React.createElement("th", {
    scope: "col",
    className: "w-[76px] min-w-[76px] p-2 align-top text-center sm:w-[140px] sm:min-w-[140px]"
  }, "ARQUIVOS"), masterVisibleCols.situacao && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-text-col w-[6%]",
    label: "Situa\xE7\xE3o",
    field: "situacao",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchSituacao,
    onSearchChange: setSearchSituacao
  }), masterVisibleCols.secLog && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-text-col w-[5%]",
    label: "SEC LOG",
    field: "sec_log",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchSecLog,
    onSearchChange: setSearchSecLog
  }), masterVisibleCols.fornecedor && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-text-col w-[10%]",
    label: "Fornecedor",
    field: "fornecedor",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchFornecedor,
    onSearchChange: setSearchFornecedor
  }), masterVisibleCols.objeto && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-text-col w-[10%]",
    label: "Objeto",
    field: "objeto",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchObjeto,
    onSearchChange: setSearchObjeto
  }), masterVisibleCols.gestorFiscal && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-text-col w-[7%]",
    label: "Gestores/Fiscais",
    field: "gestor",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchGestorFiscal,
    onSearchChange: setSearchGestorFiscal
  }), masterVisibleCols.dataInic && /*#__PURE__*/React.createElement(DateFilterHeader, {
    widthClass: "w-[5%]",
    label: "In\xEDcio",
    field: "data_inic",
    current: sortConfig,
    onSort: handleSort,
    dateFilters: dateFilters,
    setDateFilters: setDateFilters,
    align: "center"
  }), masterVisibleCols.dataFim && /*#__PURE__*/React.createElement(DateFilterHeader, {
    widthClass: "w-[5%]",
    label: "Fim",
    field: "data_fim",
    current: sortConfig,
    onSort: handleSort,
    dateFilters: dateFilters,
    setDateFilters: setDateFilters,
    align: "center"
  }), masterVisibleCols.percTempo && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "% Tempo",
    field: "perc_tempo",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.diasPassaram && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[5%]",
    label: "Passaram",
    field: "dias_passaram",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.encerrandoDias && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[5%]",
    label: "Faltam",
    field: "encerrando_dias",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.ao && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-code-col",
    label: "AO",
    field: "ao_codigos",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchAo,
    onSearchChange: setSearchAo
  }), masterVisibleCols.po && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-code-col",
    label: "PO",
    field: "po_codigos",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchPo,
    onSearchChange: setSearchPo
  }), masterVisibleCols.nd && /*#__PURE__*/React.createElement(TextHeader, {
    widthClass: "master-code-col",
    label: "ND",
    field: "nd_codigos",
    current: sortConfig,
    onSort: handleSort,
    searchVal: searchNd,
    onSearchChange: setSearchNd
  }), masterVisibleCols.difGlobal && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "GLOBAL-EMP",
    field: "dif_global",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.vGlobal && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "Global",
    field: "v_global",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.empenhado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "Empenhado",
    field: "v_empenhado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.recebido && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "Recebido",
    field: "v_recebido",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pRecebido && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "RCB %",
    field: "p_recebido",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.liquidado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "Liquidado",
    field: "v_liquidado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pLiquidado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "Liq %",
    field: "p_liquidado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.aLiquidar && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "A Liquidar",
    field: "v_a_liquidar",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pALiquidar && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "A Liq %",
    field: "p_a_liquidar",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.pago && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "Pago",
    field: "v_pago",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pPago && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "Pago %",
    field: "p_pago",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.aPagar && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "A Pagar",
    field: "v_a_pagar",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pAPagar && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "A Pagar %",
    field: "p_a_pagar",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.bloqueado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "Bloqueado",
    field: "v_bloqueado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pBloqueado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "Bloq %",
    field: "p_bloqueado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.cancelado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "Cancelado",
    field: "v_cancelado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pCancelado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "Canc %",
    field: "p_cancelado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.executado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "Executado",
    field: "v_executado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pExecutado && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "Exec %",
    field: "p_executado",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }), masterVisibleCols.execLiq && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[6%]",
    label: "EXEC LIQ",
    field: "v_pago",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "right"
  }), masterVisibleCols.pExecLiq && /*#__PURE__*/React.createElement(NumericHeader, {
    widthClass: "w-[4%]",
    label: "EXEC LIQ %",
    field: "p_pago",
    current: sortConfig,
    onSort: handleSort,
    numFilters: numFilters,
    setNumFilters: setNumFilters,
    align: "center"
  }))), /*#__PURE__*/React.createElement("tbody", {
    className: "divide-y divide-slate-100"
  }, filteredData.slice(0, 100).map((row, i) => {
    const budgetSelection = expandedBudgetDimensions[row.contrato] || [];
    const budgetDetails = getSelectedBudgetDetails(row.contrato, budgetSelection);
    const hasBudgetDetails = (budgetBreakdownByContract[row.contrato] || []).length > 0;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: `${row.contrato}-${i}`
    }, /*#__PURE__*/React.createElement("tr", {
      className: "hover:bg-blue-50 transition-colors"
    }, masterVisibleCols.contrato && /*#__PURE__*/React.createElement("td", {
      className: "master-text-col p-3 font-black text-slate-800 break-words"
    }, row.contrato, /*#__PURE__*/React.createElement("div", {
      className: "text-[8px] font-normal text-slate-500 mt-1 leading-tight"
    }, "Compra: ", row.compra, /*#__PURE__*/React.createElement("br", null), "Mod: ", row.modalidade)), masterVisibleCols.arquivos && /*#__PURE__*/React.createElement("td", {
      className: "p-3 align-top"
    }, /*#__PURE__*/React.createElement(ContractFilesCell, {
      row: row
    })), masterVisibleCols.situacao && /*#__PURE__*/React.createElement("td", {
      className: "master-text-col p-3 align-top"
    }, /*#__PURE__*/React.createElement("div", {
      className: "flex flex-wrap gap-1"
    }, row.situacaoFlags.map((f, idx) => /*#__PURE__*/React.createElement("span", {
      key: idx,
      className: `text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${f.color}`
    }, f.label)))), masterVisibleCols.secLog && /*#__PURE__*/React.createElement("td", {
      className: "master-text-col p-3 text-slate-600 font-black break-words"
    }, row.sec_log), masterVisibleCols.fornecedor && /*#__PURE__*/React.createElement("td", {
      className: "master-text-col p-3 text-slate-600 font-bold break-words"
    }, /*#__PURE__*/React.createElement(CounterpartyLink, {
      name: row.fornecedor,
      title: "Abrir fornecedor no Portal da Transpar\xEAncia"
    })), masterVisibleCols.objeto && /*#__PURE__*/React.createElement("td", {
      className: "master-text-col p-3 text-slate-500 break-words"
    }, row.objeto), masterVisibleCols.gestorFiscal && /*#__PURE__*/React.createElement("td", {
      className: "master-text-col p-3 break-words"
    }, /*#__PURE__*/React.createElement("div", {
      className: "font-bold text-slate-700",
      title: "Gestor Titular"
    }, "GT: ", row.gestor), row.gestor_sub !== 'N/I' && /*#__PURE__*/React.createElement("div", {
      className: "text-[9px] text-slate-500",
      title: "Gestor Substituto"
    }, "GS: ", row.gestor_sub), /*#__PURE__*/React.createElement("div", {
      className: "font-bold text-slate-700 mt-1",
      title: "Fiscal Titular"
    }, "FT: ", row.fiscal), row.fiscal_sub !== 'N/I' && /*#__PURE__*/React.createElement("div", {
      className: "text-[9px] text-slate-500",
      title: "Fiscal Substituto"
    }, "FS: ", row.fiscal_sub)), masterVisibleCols.dataInic && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-slate-500 font-bold break-words text-center"
    }, row.data_inic || "-"), masterVisibleCols.dataFim && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-slate-500 font-bold break-words text-center"
    }, row.data_fim || "-"), masterVisibleCols.percTempo && /*#__PURE__*/React.createElement("td", {
      className: "p-3 align-middle"
    }, row.perc_tempo !== null ? /*#__PURE__*/React.createElement("div", {
      className: "flex items-center gap-1"
    }, /*#__PURE__*/React.createElement("div", {
      className: "w-full bg-slate-200 rounded-full h-1.5 flex-1 overflow-hidden"
    }, /*#__PURE__*/React.createElement("div", {
      className: `h-1.5 rounded-full ${row.perc_tempo >= 1 ? 'bg-red-500' : 'bg-emerald-500'}`,
      style: {
        width: `${Math.min(Math.max(row.perc_tempo * 100, 0), 100)}%`
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "text-[8px] font-bold text-slate-600 min-w-[30px] text-right"
    }, formatPercentBR(row.perc_tempo))) : "-"), masterVisibleCols.diasPassaram && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-bold text-slate-600"
    }, row.dias_passaram !== null ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", null, row.dias_passaram, " d"), /*#__PURE__*/React.createElement("div", {
      className: "mt-1 text-[8px] font-semibold text-slate-400 normal-case"
    }, formatDurationDays(row.dias_passaram))) : "-"), masterVisibleCols.encerrandoDias && /*#__PURE__*/React.createElement("td", {
      className: `p-3 text-center font-bold ${row.encerrando_dias < 0 ? 'text-red-500' : 'text-emerald-600'}`
    }, row.encerrando_dias !== null ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", null, row.encerrando_dias, " d"), /*#__PURE__*/React.createElement("div", {
      className: "mt-1 text-[8px] font-semibold opacity-70 normal-case"
    }, formatDurationDays(row.encerrando_dias))) : "-"), masterVisibleCols.ao && /*#__PURE__*/React.createElement("td", {
      className: "master-code-col p-3 text-slate-600 font-bold",
      title: (row.ao_filter_values || []).join('\n')
    }, row.ao_codigos), masterVisibleCols.po && /*#__PURE__*/React.createElement("td", {
      className: "master-code-col p-3 text-slate-600 font-bold",
      title: (row.po_filter_values || []).join('\n')
    }, row.po_codigos), masterVisibleCols.nd && /*#__PURE__*/React.createElement("td", {
      className: "master-code-col p-3 text-slate-600 font-bold",
      title: (row.nd_filter_values || []).join('\n')
    }, row.nd_codigos), masterVisibleCols.difGlobal && /*#__PURE__*/React.createElement("td", {
      className: `p-3 text-right font-bold ${row.dif_global < 0 ? 'text-red-500' : row.dif_global > 0 ? 'text-emerald-600' : 'text-slate-500'} bg-slate-50/30`
    }, hasBudgetDetails && /*#__PURE__*/React.createElement("div", {
      className: "mb-1 flex w-full flex-wrap items-center justify-end gap-1",
      "aria-label": "Selecionar dimens\xF5es do detalhamento or\xE7ament\xE1rio"
    }, ['ao', 'po', 'nd'].map(dimension => {
      const active = budgetSelection.includes(dimension);
      return /*#__PURE__*/React.createElement("button", {
        key: dimension,
        onClick: () => toggleBudgetDimension(row.contrato, dimension),
        className: `rounded border px-1.5 py-0.5 text-[8px] font-black uppercase transition ${active ? 'border-blue-700 bg-blue-700 text-white' : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'}`,
        title: `${active ? 'Ocultar' : 'Exibir'} detalhamento por ${dimension.toUpperCase()}`,
        "aria-pressed": active
      }, active ? '▼' : '▶', " ", dimension.toUpperCase());
    })), formatBRL(row.dif_global)), masterVisibleCols.vGlobal && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-bold text-slate-700 bg-slate-50/30",
      "data-metric": "global",
      style: MetricColors.textStyle('global')
    }, formatBRL(row.v_global)), masterVisibleCols.empenhado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-bold text-blue-700",
      "data-metric": "empenhado",
      style: MetricColors.textStyle('empenhado')
    }, formatBRL(row.v_empenhado)), masterVisibleCols.recebido && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-bold text-violet-700"
    }, formatBRL(row.v_recebido)), masterVisibleCols.pRecebido && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-bold text-violet-700 bg-violet-50/30"
    }, formatPercentBR(row.p_recebido)), masterVisibleCols.liquidado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-bold text-amber-600",
      "data-metric": "liquidado",
      style: MetricColors.textStyle('liquidado')
    }, formatBRL(row.v_liquidado)), masterVisibleCols.pLiquidado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-bold opacity-70 bg-slate-50/50",
      "data-metric": "liquidado",
      style: MetricColors.textStyle('liquidado')
    }, formatPercentBR(row.p_liquidado)), masterVisibleCols.aLiquidar && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-bold text-amber-500"
    }, formatBRL(row.v_a_liquidar)), masterVisibleCols.pALiquidar && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-bold opacity-70 bg-slate-50/50"
    }, formatPercentBR(row.p_a_liquidar)), masterVisibleCols.pago && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-black text-emerald-600",
      "data-metric": "pago",
      style: MetricColors.textStyle('pago')
    }, formatBRL(row.v_pago)), masterVisibleCols.pPago && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-bold opacity-70 bg-slate-50/50",
      "data-metric": "pago",
      style: MetricColors.textStyle('pago')
    }, formatPercentBR(row.p_pago)), masterVisibleCols.aPagar && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-bold text-emerald-500"
    }, formatBRL(row.v_a_pagar)), masterVisibleCols.pAPagar && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-bold opacity-70 bg-slate-50/50"
    }, formatPercentBR(row.p_a_pagar)), masterVisibleCols.bloqueado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-bold text-orange-600",
      "data-metric": "bloqueado",
      style: MetricColors.textStyle('bloqueado')
    }, formatBRL(row.v_bloqueado)), masterVisibleCols.pBloqueado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-bold opacity-70 bg-slate-50/50",
      "data-metric": "bloqueado",
      style: MetricColors.textStyle('bloqueado')
    }, formatPercentBR(row.p_bloqueado)), masterVisibleCols.cancelado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-bold text-red-600",
      "data-metric": "cancelado",
      style: MetricColors.textStyle('cancelado')
    }, formatBRL(row.v_cancelado)), masterVisibleCols.pCancelado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-bold opacity-70 bg-slate-50/50",
      "data-metric": "cancelado",
      style: MetricColors.textStyle('cancelado')
    }, formatPercentBR(row.p_cancelado)), masterVisibleCols.executado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-black text-blue-600"
    }, formatBRL(row.v_executado)), masterVisibleCols.pExecutado && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-black text-blue-800 bg-slate-50/50"
    }, formatPercentBR(row.p_executado)), masterVisibleCols.execLiq && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-right font-black text-violet-600",
      "data-metric": "pago",
      style: MetricColors.textStyle('pago')
    }, formatBRL(row.v_pago)), masterVisibleCols.pExecLiq && /*#__PURE__*/React.createElement("td", {
      className: "p-3 text-center font-black text-violet-800 bg-violet-50/30",
      "data-metric": "pago",
      style: MetricColors.textStyle('pago')
    }, formatPercentBR(row.p_pago))), budgetSelection.length > 0 && budgetDetails.map((detail, detailIndex) => renderBudgetDetailRow(detail, `${row.contrato}-orc-${budgetSelection.join('-')}-${detailIndex}`)));
  })), /*#__PURE__*/React.createElement("tfoot", {
    className: "bg-slate-200 sticky bottom-0 border-t-2 border-slate-400 shadow-md z-10"
  }, /*#__PURE__*/React.createElement("tr", {
    className: "text-slate-800 uppercase font-black"
  }, masterNonMetricColCount > 0 && /*#__PURE__*/React.createElement("td", {
    colSpan: masterNonMetricColCount,
    className: "master-text-col p-3 text-right"
  }, "TOTAIS (Filtro Atual):"), masterVisibleCols.difGlobal && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-slate-700"
  }, formatBRL(totalsMaster.dif)), masterVisibleCols.vGlobal && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-slate-700",
    "data-metric": "global",
    style: MetricColors.textStyle('global')
  }, formatBRL(totalsMaster.global)), masterVisibleCols.empenhado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-blue-800",
    "data-metric": "empenhado",
    style: MetricColors.textStyle('empenhado')
  }, formatBRL(totalsMaster.emp)), masterVisibleCols.recebido && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-violet-800"
  }, formatBRL(totalsMaster.rec)), masterVisibleCols.pRecebido && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center text-violet-800"
  }, formatPercentBR(totalsMaster.p_rec)), masterVisibleCols.liquidado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-amber-800",
    "data-metric": "liquidado",
    style: MetricColors.textStyle('liquidado')
  }, formatBRL(totalsMaster.liq)), masterVisibleCols.pLiquidado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center"
  }, "-"), masterVisibleCols.aLiquidar && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-amber-600"
  }, formatBRL(totalsMaster.a_liq)), masterVisibleCols.pALiquidar && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center"
  }, "-"), masterVisibleCols.pago && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-emerald-800",
    "data-metric": "pago",
    style: MetricColors.textStyle('pago')
  }, formatBRL(totalsMaster.pag)), masterVisibleCols.pPago && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center"
  }, "-"), masterVisibleCols.aPagar && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-emerald-600"
  }, formatBRL(totalsMaster.a_pag)), masterVisibleCols.pAPagar && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center"
  }, "-"), masterVisibleCols.bloqueado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-orange-800",
    "data-metric": "bloqueado",
    style: MetricColors.textStyle('bloqueado')
  }, formatBRL(totalsMaster.blo)), masterVisibleCols.pBloqueado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center"
  }, "-"), masterVisibleCols.cancelado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-red-800",
    "data-metric": "cancelado",
    style: MetricColors.textStyle('cancelado')
  }, formatBRL(totalsMaster.can)), masterVisibleCols.pCancelado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center"
  }, "-"), masterVisibleCols.executado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-blue-800"
  }, formatBRL(totalsMaster.exe)), masterVisibleCols.pExecutado && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center"
  }, "-"), masterVisibleCols.execLiq && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-right text-violet-800",
    "data-metric": "pago",
    style: MetricColors.textStyle('pago')
  }, formatBRL(totalsMaster.pag)), masterVisibleCols.pExecLiq && /*#__PURE__*/React.createElement("td", {
    className: "p-3 text-center"
  }, "-"))))))), documentDashboard.page4, documentDashboard.page5);
}
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }
  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      error
    };
  }
  render() {
    if (this.state.hasError) return /*#__PURE__*/React.createElement("div", {
      className: "min-h-screen flex flex-col items-center justify-center bg-red-50 p-8"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "text-2xl font-black text-red-600 mb-4 uppercase"
    }, "Erro Detetado no Painel"), /*#__PURE__*/React.createElement("p", {
      className: "text-slate-700 mb-6 font-bold"
    }, this.state.error.toString()), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        clearAuthStorage();
        localStorage.removeItem(DASH_CACHE_KEY);
        localStorage.removeItem('dashData_TotalV6');
        window.location.reload();
      },
      className: "bg-red-600 text-white px-6 py-3 rounded shadow font-bold hover:bg-red-700"
    }, "Limpar Sess\xE3o e Recarregar"));
    return this.props.children;
  }
}

// 7. AUTENTICAÇÃO — credenciais e token da API; regras de acesso executadas no servidor.
function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => isAuthSessionValid());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLogging, setIsLogging] = useState(false);
  const handleLogin = async e => {
    e.preventDefault();
    setError("");
    setIsLogging(true);
    try {
      var _json$usuario, _json$usuario2, _json$usuario3, _json$usuario4, _json$usuario5, _json$usuario6;
      const body = new URLSearchParams();
      body.append("acao", "login");
      body.append("usuario", username);
      body.append("senha", password);
      const resp = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        body
      });
      const json = await readAppsScriptJson(resp, 'o login');
      if (!json.ok) {
        setError(json.mensagem || "Credenciais inválidas.");
        setIsLogging(false);
        return;
      }
      sessionStorage.setItem('token_TotalV6', json.token);
      sessionStorage.setItem('summary_pending_TotalV6', '1');
      sessionStorage.setItem('user_TotalV6', ((_json$usuario = json.usuario) === null || _json$usuario === void 0 ? void 0 : _json$usuario.nome) || username);
      sessionStorage.setItem('perfil_TotalV6', ((_json$usuario2 = json.usuario) === null || _json$usuario2 === void 0 ? void 0 : _json$usuario2.perfil) || '');
      sessionStorage.setItem('ativo_TotalV6', ((_json$usuario3 = json.usuario) === null || _json$usuario3 === void 0 ? void 0 : _json$usuario3.ativo) || '');
      sessionStorage.setItem('validade_TotalV6', ((_json$usuario4 = json.usuario) === null || _json$usuario4 === void 0 ? void 0 : _json$usuario4.validade) || '');
      sessionStorage.setItem('duracao_diaria_horas_TotalV6', ((_json$usuario5 = json.usuario) === null || _json$usuario5 === void 0 ? void 0 : _json$usuario5.duracao_diaria_horas) || '');
      sessionStorage.setItem('expira_TotalV6', ((_json$usuario6 = json.usuario) === null || _json$usuario6 === void 0 ? void 0 : _json$usuario6.expira_em) || '');
      try {
        localStorage.removeItem(DASH_CACHE_KEY);
        localStorage.removeItem('dashData_TotalV6');
      } catch (e) {}
      setIsAuthenticated(true);
      setIsLogging(false);
    } catch (erro) {
      console.error(erro);
      setError("Falha ao tentar fazer login pelo Apps Script.");
      setIsLogging(false);
    }
  };
  if (!isAuthenticated) {
    return /*#__PURE__*/React.createElement("div", {
      className: "min-h-screen flex items-center justify-center bg-slate-800 relative overflow-hidden"
    }, /*#__PURE__*/React.createElement("div", {
      className: "absolute inset-0 opacity-10 pointer-events-none",
      style: {
        backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)',
        backgroundSize: '20px 20px'
      }
    }), /*#__PURE__*/React.createElement("div", {
      className: "bg-white p-8 rounded-2xl shadow-2xl w-[400px] max-w-[90%] border-t-8 border-blue-600 relative z-10"
    }, /*#__PURE__*/React.createElement("div", {
      className: "text-center mb-8"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "text-2xl font-black text-red-600 uppercase tracking-tighter leading-tight"
    }, "Acesso Restrito"), /*#__PURE__*/React.createElement("p", {
      className: "text-xs font-bold text-slate-500 mt-2 uppercase tracking-widest"
    }, "Painel de Contratos")), /*#__PURE__*/React.createElement("form", {
      onSubmit: handleLogin,
      className: "space-y-5"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-[10px] font-black text-slate-500 uppercase mb-1"
    }, "Usu\xE1rio"), /*#__PURE__*/React.createElement("input", {
      type: "text",
      value: username,
      onChange: e => setUsername(e.target.value),
      className: "w-full border border-slate-300 px-3 py-3 rounded text-sm font-bold text-slate-700 outline-none focus:border-blue-500 bg-slate-50",
      placeholder: "Digite o usu\xE1rio...",
      autoComplete: "username"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
      className: "block text-[10px] font-black text-slate-500 uppercase mb-1"
    }, "Senha"), /*#__PURE__*/React.createElement("input", {
      type: "password",
      value: password,
      onChange: e => setPassword(e.target.value),
      className: "w-full border border-slate-300 px-3 py-3 rounded text-sm font-bold text-slate-700 outline-none focus:border-blue-500 bg-slate-50",
      placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
      autoComplete: "current-password"
    })), error && /*#__PURE__*/React.createElement("div", {
      className: "bg-red-50 border-l-4 border-red-500 p-3 rounded"
    }, /*#__PURE__*/React.createElement("p", {
      className: "text-[11px] font-bold text-red-600 text-center"
    }, error)), /*#__PURE__*/React.createElement("button", {
      type: "submit",
      disabled: isLogging,
      className: `w-full text-white font-black uppercase text-[11px] tracking-widest py-4 rounded transition-colors shadow-lg mt-2 ${isLogging ? 'bg-slate-400 cursor-wait' : 'bg-slate-800 hover:bg-slate-900'}`
    }, isLogging ? 'Autenticando...' : 'Autenticar Acesso')), /*#__PURE__*/React.createElement("p", {
      className: "mt-6 text-center text-[10px] font-black uppercase tracking-widest text-slate-500"
    }, "Vers\xE3o ", DASH_VERSION, " \u2013 Produzido por Cel Brito")));
  }
  return /*#__PURE__*/React.createElement(ErrorBoundary, null, /*#__PURE__*/React.createElement(Dashboard, null));
}
ReactDOM.render(/*#__PURE__*/React.createElement(App, null), document.getElementById('root'));
