/************************************************************
 * APPS SCRIPT - DASHCONTRATO
 * GitHub Pages -> Apps Script -> Google Planilhas
 *
 * Aba de usuários esperada: USUARIOS
 * Colunas esperadas:
 * USUARIO | NOME | SENHA | PERFIL | ATIVO | SEC_LOG | FORNECEDOR | CONTRATO | VIGENCIA | VALIDADE | ACESSOS_DIARIOS | DURACAO_DIARIA
 *
 * Versão: V3, revisão V7-log-1
 *
 * REGRAS GERAIS
 * - USUARIO e NOME são case-sensitive.
 * - Campos em branco liberam tudo, exceto quando há regra específica de limitação.
 * - FORNECEDOR mantém busca aproximada por nome.
 * - SEC_LOG e CONTRATO aceitam separação por vírgula ou ponto-e-vírgula.
 * - ATIVO=NAO/NÃO bloqueia login/API. ATIVO em branco bloqueia.
 * - ATIVO=SIM aplica as demais regras.
 * - ATIVO=LIMITADO aplica limite diário de API por ACESSOS_DIARIOS; se ACESSOS_DIARIOS em branco, bloqueia.
 * - DURACAO_DIARIA, quando indicada, expira a sessão em horas a partir do login.
 * - DURACAO_DIARIA em branco não aplica expiração por duração, exceto limpeza operacional manual.
 *
 * PERFIS
 * - ADMIN: respeita apenas ATIVO e senha. Ignora SEC_LOG, FORNECEDOR, CONTRATO, VIGENCIA, VALIDADE, ACESSOS_DIARIOS e DURACAO_DIARIA.
 * - COLABORADOR: respeita as restrições quando indicadas.
 * - CHEFE: sempre restrito por SEC_LOG da coluna USUARIOS. Se SEC_LOG em branco, bloqueia. Também respeita as demais restrições quando indicadas.
 * - GESTOR: sempre restrito por NOME em GESTOR_TITULAR ou GESTOR_SUBSTITUTO. Também respeita as demais restrições quando indicadas.
 * - FISCAL: sempre restrito por NOME em FISCAL_TITULAR ou FISCAL_SUBSTITUTO. Também respeita as demais restrições quando indicadas.
 * - FORNECEDOR: sempre restrito por FORNECEDOR da coluna USUARIOS. Se FORNECEDOR em branco, bloqueia. Também respeita as demais restrições quando indicadas.
 ************************************************************/

const CONFIG = {
  ABA_USUARIOS: "USUARIOS",
  SPREADSHEET_ID_LOG_ACESSO: "1rcO6fd8Djx0ryTp8pwKpBs2eF_GlcGPEQajsHg17cl8",
  ABA_LOG_ACESSO: "LOG_ACESSO",
  FUSO_LOG_ACESSO: "America/Sao_Paulo",

  // Confira se estes IDs continuam corretos para seu ambiente.
  SPREADSHEET_ID_CONTABIL: "1rRup03vk20FWxhbkClXBLVZ2X1N8AZpFyjevbkzP4-w",
  RANGE_CONTABIL: "CONTROLE_EXEC_CONTR_DOC!A:K",

  SPREADSHEET_ID_GERAL: "1Fuhb3HMRzg2kEozkuREFNKYSXtqUCLhZWFFuWM-f3v4",
  // A1 identifica a aba; a leitura da Geral inclui todas as colunas preenchidas.
  RANGE_GERAL: "CONTROLE_EXEC_CONTR!A1",

  // Fonte orcamentaria vinculada a CONTABIL por Documento CCor Número.
  SPREADSHEET_ID_ORCAMENTARIO: "1Dn-fEgKc_t33tBZ-zvvkjUd28s8AbqhojDVaLtw0fXo",
  SHEET_GID_ORCAMENTARIO: 0,

  // Usado apenas para limpeza operacional quando não houver DURACAO_DIARIA.
  SESSAO_SEM_DURACAO_HORAS: 24 * 365
};

const REVISAO_API = "V7-log-1";

const PERFIS_VALIDOS = [
  "ADMIN",
  "COLABORADOR",
  "CHEFE",
  "GESTOR",
  "FISCAL",
  "FORNECEDOR"
];

/************************************************************
 * ROTAS PRINCIPAIS
 ************************************************************/

function doGet(e) {
  try {
    const acao = String(
      e && e.parameter && (e.parameter.acao || e.parameter.ação) || ""
    ).toLowerCase().trim();

    if (!acao) {
      return respostaJson({
        ok: true,
        mensagem: "API do dashboard publicada. Use ?acao=status para testar.",
        exemplos: {
          status: "?acao=status",
          cabecalhos: "?acao=cabecalhos",
          dados: "?acao=dados&token=SEU_TOKEN"
        }
      });
    }

    if (acao === "status") {
      return respostaJson({
        ok: true,
        mensagem: "API do dashboard ativa.",
        versao: "V3",
        revisao: REVISAO_API
      });
    }

    if (acao === "cabecalhos") {
      return diagnosticarCabecalhos();
    }

    if (acao === "dados") {
      return obterDados(e);
    }

    return respostaJson({
      ok: false,
      mensagem: "Ação inválida.",
      acaoRecebida: acao,
      acoesValidas: ["status", "cabecalhos", "dados"]
    });

  } catch (erro) {
    return respostaJson({
      ok: false,
      mensagem: "Erro interno no doGet: " + erro.message
    });
  }
}

function doPost(e) {
  try {
    const body = obterBodyPost(e);
    const acao = String(body.acao || "").toLowerCase().trim();

    if (acao === "log_acesso") return logEventoDoNavegador(body);

    if (acao === "login") {
      return login(body);
    }

    return respostaJson({
      ok: false,
      mensagem: "Ação inválida.",
      acoesValidas: ["login", "log_acesso"]
    });

  } catch (erro) {
    return respostaJson({
      ok: false,
      mensagem: "Erro interno no doPost: " + erro.message
    });
  }
}

/************************************************************
 * LOGIN
 ************************************************************/

function login(body) {
  const usuarioDigitado = normalizarLogin(body.usuario);
  const senhaDigitada = String(body.senha || "");

  if (!usuarioDigitado || !senhaDigitada) {
    return respostaJson({
      ok: false,
      mensagem: "Informe usuário e senha. Usuário diferencia maiúsculas e minúsculas."
    });
  }

  const usuario = buscarUsuarioPorLogin(usuarioDigitado);

  if (!usuario) {
    return respostaJson({
      ok: false,
      mensagem: "Usuário não encontrado. Confira maiúsculas e minúsculas."
    });
  }

  const perfil = normalizarPerfil(usuario.PERFIL);

  if (!PERFIS_VALIDOS.includes(perfil)) {
    return respostaJson({
      ok: false,
      mensagem: "Perfil inválido na planilha de usuários."
    });
  }

  if (String(usuario.SENHA || "") !== senhaDigitada) {
    return respostaJson({
      ok: false,
      mensagem: "Senha incorreta."
    });
  }

  const ativo = normalizarTexto(usuario.ATIVO);
  const validacaoAtivo = validarAtivoParaLogin(ativo, perfil, usuario.ACESSOS_DIARIOS);

  if (!validacaoAtivo.ok) {
    return respostaJson({
      ok: false,
      mensagem: validacaoAtivo.mensagem
    });
  }

  // ADMIN ignora VALIDADE, mesmo se indicada.
  if (perfil !== "ADMIN") {
    if (!validadeAindaValida(usuario.VALIDADE, true)) {
      return respostaJson({
        ok: false,
        mensagem: "Senha vencida. Solicite renovação de acesso."
      });
    }
  }

  limparSessoesExpiradas();

  const token = Utilities.getUuid();
  const agora = Date.now();
  const duracaoHoras = obterDuracaoDiariaHoras(usuario.DURACAO_DIARIA, perfil);
  const expiraEm = duracaoHoras ? agora + duracaoHoras * 60 * 60 * 1000 : null;

  const sessao = montarSessao(usuario, perfil, ativo, agora, expiraEm, duracaoHoras);

  PropertiesService.getScriptProperties().setProperty(
    "sessao_" + token,
    JSON.stringify(sessao)
  );

  return respostaJson({
    ok: true,
    token: token,
    revisao: REVISAO_API,
    recursos: { log_acesso: true },
    logAcesso: logGravar(sessao, "ACESSO_INCIAL", logIdValido(body.evento_id) ? body.evento_id : Utilities.getUuid()),
    usuario: {
      usuario: sessao.usuario,
      nome: sessao.nome,
      perfil: sessao.perfil,
      ativo: sessao.ativo,
      validade: sessao.validade,
      duracao_diaria_horas: sessao.duracao_diaria_horas,
      expira_em: sessao.expiraEm
    }
  });
}

function montarSessao(usuario, perfil, ativo, primeiroAcessoEm, expiraEm, duracaoHoras) {
  return {
    usuario: String(usuario.USUARIO || usuario.USARIO || ""),
    nome: String(usuario.NOME || ""),
    perfil: perfil,
    ativo: ativo,
    sec_log: String(usuario.SEC_LOG || ""),
    fornecedor: String(usuario.FORNECEDOR || ""),
    contrato: String(usuario.CONTRATO || ""),
    vigencia: String(usuario.VIGENCIA || ""),
    validade: formatarDataParaTexto(usuario.VALIDADE),
    validade_raw: valorOriginalData(usuario.VALIDADE),
    acessos_diarios: String(usuario.ACESSOS_DIARIOS || ""),
    duracao_diaria: String(usuario.DURACAO_DIARIA || ""),
    duracao_diaria_horas: duracaoHoras,
    primeiroAcessoEm: primeiroAcessoEm,
    expiraEm: expiraEm
  };
}

function validarAtivoParaLogin(ativo, perfil, acessosDiarios) {
  if (!ativo) {
    return { ok: false, mensagem: "Coluna ATIVO em branco. Acesso bloqueado." };
  }

  if (ativo === "NAO" || ativo === "NÃO") {
    return { ok: false, mensagem: "Usuário sem acesso pela coluna ATIVO." };
  }

  if (ativo === "SIM") {
    return { ok: true };
  }

  if (ativo === "LIMITADO") {
    // ADMIN ignora ACESSOS_DIARIOS, mas ATIVO precisa estar válido e diferente de NAO.
    if (perfil === "ADMIN") {
      return { ok: true };
    }

    const limite = parseInteiroPositivo(acessosDiarios);
    if (!limite) {
      return {
        ok: false,
        mensagem: "ATIVO=LIMITADO exige ACESSOS_DIARIOS preenchido com número maior que zero."
      };
    }

    return { ok: true };
  }

  return { ok: false, mensagem: "Valor inválido na coluna ATIVO. Use SIM, NAO ou LIMITADO." };
}

function buscarUsuarioPorLogin(loginCaseSensitive) {
  const usuarios = lerUsuarios();

  return usuarios.find(u => {
    const loginPlanilha = normalizarLogin(u.USUARIO || u.USARIO);
    return loginPlanilha === loginCaseSensitive;
  }) || null;
}

/************************************************************
 * OBTER DADOS
 ************************************************************/

function obterDados(e) {
  const token = e.parameter.token;
  const sessao = validarSessao(token);

  if (!sessao) {
    return respostaJson({
      ok: false,
      mensagem: "Sessão inválida ou expirada. Faça login novamente."
    });
  }

  const controleAcesso = registrarAcessoApi(sessao);
  const logAcesso = logEventoDaCarga(e.parameter, sessao, controleAcesso);
  if (!controleAcesso.ok) {
    return respostaJson({
      ok: false,
      mensagem: controleAcesso.mensagem,
      recursos: { log_acesso: true },
      logAcesso: logAcesso,
      limiteAcessos: controleAcesso.limite || null,
      acessosUsados: controleAcesso.usados || null
    });
  }

  const geralRowsOriginais = lerRange(CONFIG.SPREADSHEET_ID_GERAL, CONFIG.RANGE_GERAL, true);
  const contabilRowsOriginais = lerRange(CONFIG.SPREADSHEET_ID_CONTABIL, CONFIG.RANGE_CONTABIL);
  const orcamentarioRowsOriginais = lerAbaPorGid(
    CONFIG.SPREADSHEET_ID_ORCAMENTARIO,
    CONFIG.SHEET_GID_ORCAMENTARIO
  );

  const geralRows = prepararTabelaComCabecalho(
    geralRowsOriginais,
    [
      "Número Contrato",
      "Numero Contrato",
      "Nº Contrato",
      "N Contrato",
      "Contrato",
      "COL_NR_CONTR_BASE"
    ],
    "planilha geral"
  );

  const contabilRows = prepararTabelaComCabecalho(
    contabilRowsOriginais,
    [
      "COL_NR_CONTR_BASE",
      "Contrato",
      "Número Contrato",
      "Numero Contrato"
    ],
    "planilha contábil"
  );

  const orcamentarioRows = prepararTabelaComCabecalho(
    orcamentarioRowsOriginais,
    ["Documento CCor Número", "Documento CCor Numero", "DOCUMENTO_CCOR_NUMERO"],
    "planilha de classificação orçamentária"
  );

  const resultado = filtrarDadosPorUsuario(sessao, geralRows, contabilRows, orcamentarioRows);

  return respostaJson({
    ok: true,
    versao: "V3",
    revisao: REVISAO_API,
    recursos: { log_acesso: true },
    logAcesso: logAcesso,
    usuario: {
      usuario: sessao.usuario,
      nome: sessao.nome,
      perfil: sessao.perfil,
      ativo: sessao.ativo,
      validade: sessao.validade,
      duracao_diaria_horas: sessao.duracao_diaria_horas,
      expira_em: sessao.expiraEm
    },
    geral: serializarLinhasParaJson(resultado.geral),
    contabil: serializarLinhasParaJson(resultado.contabil),
    orcamentario: serializarLinhasParaJson(resultado.orcamentario),
    diagnosticoOrcamentario: resultado.orcamentario.diagnosticoVinculos || null,
    totais: {
      geral: Math.max(0, resultado.geral.length - 1),
      contabil: Math.max(0, resultado.contabil.length - 1),
      orcamentario: Math.max(0, resultado.orcamentario.length - 1)
    },
    controleAcesso: {
      limite: controleAcesso.limite ?? null,
      usados: controleAcesso.usados ?? null,
      restantes: controleAcesso.restantes ?? null,
      regra: "Cada carga ou sincronização de dados consome 1 acesso por usuário e por dia",
      fuso: Session.getScriptTimeZone(),
      reinicia: "00:00"
    }
  });
}

/************************************************************
 * SESSÃO
 ************************************************************/

function validarSessao(token) {
  if (!token) return null;

  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("sessao_" + token);

  if (!raw) return null;

  let sessao = JSON.parse(raw);

  if (sessao.expiraEm && Date.now() > Number(sessao.expiraEm)) {
    props.deleteProperty("sessao_" + token);
    return null;
  }

  // Revalida o usuário na planilha em cada chamada de dados.
  // Isso permite bloquear API se ATIVO mudar para NAO depois do login.
  const usuarioAtual = buscarUsuarioPorLogin(sessao.usuario);
  if (!usuarioAtual) {
    props.deleteProperty("sessao_" + token);
    return null;
  }

  const perfilAtual = normalizarPerfil(usuarioAtual.PERFIL);
  const ativoAtual = normalizarTexto(usuarioAtual.ATIVO);
  const validacaoAtivo = validarAtivoParaLogin(ativoAtual, perfilAtual, usuarioAtual.ACESSOS_DIARIOS);

  if (!validacaoAtivo.ok) {
    props.deleteProperty("sessao_" + token);
    return null;
  }

  if (perfilAtual !== "ADMIN") {
    if (!validadeAindaValida(usuarioAtual.VALIDADE, true)) {
      props.deleteProperty("sessao_" + token);
      return null;
    }
  }

  // Atualiza restrições da sessão com os valores atuais da planilha, mantendo o mesmo primeiro acesso e expiração original.
  sessao = montarSessao(
    usuarioAtual,
    perfilAtual,
    ativoAtual,
    sessao.primeiroAcessoEm || Date.now(),
    sessao.expiraEm || null,
    sessao.duracao_diaria_horas || null
  );

  props.setProperty("sessao_" + token, JSON.stringify(sessao));
  return sessao;
}

function limparSessoesExpiradas() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const agora = Date.now();
  const limiteOperacional = CONFIG.SESSAO_SEM_DURACAO_HORAS * 60 * 60 * 1000;

  Object.keys(all).forEach(chave => {
    if (!chave.startsWith("sessao_")) return;

    try {
      const sessao = JSON.parse(all[chave]);

      if (sessao.expiraEm && agora > Number(sessao.expiraEm)) {
        props.deleteProperty(chave);
        return;
      }

      // Sessões sem DURACAO_DIARIA ficam sem expiração funcional,
      // mas são limpas depois de um período operacional longo para evitar acúmulo infinito.
      if (!sessao.expiraEm && sessao.primeiroAcessoEm && agora - Number(sessao.primeiroAcessoEm) > limiteOperacional) {
        props.deleteProperty(chave);
      }
    } catch (erro) {
      props.deleteProperty(chave);
    }
  });
}

/************************************************************
 * CONTROLE DE ACESSOS DIÁRIOS
 ************************************************************/

function registrarAcessoApi(sessao) {
  const perfil = normalizarPerfil(sessao.perfil);

  // ADMIN ignora ACESSOS_DIARIOS, mesmo se indicado.
  if (perfil === "ADMIN") {
    return { ok: true };
  }

  const ativo = normalizarTexto(sessao.ativo);
  const limiteInformado = parseInteiroPositivo(sessao.acessos_diarios);

  // ATIVO=LIMITADO exige limite. ATIVO=SIM só aplica limite quando indicado.
  if (ativo === "LIMITADO" && !limiteInformado) {
    return {
      ok: false,
      mensagem: "Usuário LIMITADO sem ACESSOS_DIARIOS válido. Acesso à API bloqueado."
    };
  }

  if (!limiteInformado) {
    return { ok: true };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const props = PropertiesService.getScriptProperties();
    const dia = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
    const chave = "acessos_" + sessao.usuario + "_" + dia;
    const usados = Number(props.getProperty(chave) || "0");

    if (usados >= limiteInformado) {
      return {
        ok: false,
        mensagem: "Limite diário de acessos à API atingido para este usuário.",
        limite: limiteInformado,
        usados: usados,
        restantes: 0
      };
    }

    const novoTotal = usados + 1;
    props.setProperty(chave, String(novoTotal));

    return {
      ok: true,
      limite: limiteInformado,
      usados: novoTotal,
      restantes: Math.max(0, limiteInformado - novoTotal)
    };
  } finally {
    lock.releaseLock();
  }
}

function parseInteiroPositivo(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === "") return null;

  const texto = String(valor).trim().replace(",", ".");
  const numero = Math.floor(Number(texto));

  if (!isFinite(numero) || numero <= 0) return null;
  return numero;
}

function obterDuracaoDiariaHoras(valor, perfil) {
  // ADMIN ignora DURACAO_DIARIA, mesmo se indicada.
  if (normalizarPerfil(perfil) === "ADMIN") {
    return null;
  }

  if (valor === null || valor === undefined || String(valor).trim() === "") {
    return null;
  }

  const texto = String(valor).trim().replace(",", ".");
  const horas = Number(texto);

  if (!isFinite(horas) || horas <= 0) {
    return null;
  }

  return horas;
}

/************************************************************
 * LEITURA DAS PLANILHAS
 ************************************************************/

function lerUsuarios() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.ABA_USUARIOS);

  if (!sheet) {
    throw new Error("Aba USUARIOS não encontrada na planilha de usuários.");
  }

  const values = sheet.getDataRange().getValues();

  if (!values || values.length < 2) {
    throw new Error("Aba USUARIOS está vazia ou sem usuários cadastrados.");
  }

  return linhasParaObjetos(values);
}

function lerRange(spreadsheetId, rangeA1, todasColunasDaAba = false) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const range = ss.getRange(rangeA1);
  // Evita truncar LINK_* quando novas colunas são acrescentadas à Geral.
  // A Contábil continua respeitando o intervalo configurado. As permissões
  // continuam sendo aplicadas por filtrarDadosPorUsuario antes da resposta.
  const dataRange = todasColunasDaAba ? range.getSheet().getDataRange() : range;
  return dataRange.getValues();
}

function lerAbaPorGid(spreadsheetId, sheetGid) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheetById(Number(sheetGid));

  if (!sheet) {
    throw new Error("Aba com gid=" + sheetGid + " nao encontrada na planilha " + spreadsheetId + ".");
  }

  return sheet.getDataRange().getValues();
}

function linhasParaObjetos(values) {
  const headers = values[0].map(h => normalizarCabecalho(h));

  return values.slice(1)
    .filter(row => row.some(cell => cell !== "" && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i];
      });
      return obj;
    });
}

function prepararTabelaComCabecalho(rows, nomesContrato, nomeTabela) {
  if (!rows || rows.length === 0) {
    throw new Error(nomeTabela + " vazia.");
  }

  const linhaCabecalho = encontrarLinhaCabecalho(rows, nomesContrato);

  if (linhaCabecalho < 0) {
    const resumo = rows.slice(0, 8).map((row, idx) => {
      const valores = row
        .map(v => String(v || "").trim())
        .filter(Boolean)
        .slice(0, 12)
        .join(" | ");

      return "Linha " + (idx + 1) + ": " + valores;
    }).join(" || ");

    throw new Error(
      "Coluna de contrato não encontrada na " +
      nomeTabela +
      ". Cabeçalhos/linhas iniciais lidos: " +
      resumo
    );
  }

  const cabecalho = rows[linhaCabecalho];

  const dados = rows
    .slice(linhaCabecalho + 1)
    .filter(row => row.some(cell => cell !== "" && cell !== null));

  return [cabecalho].concat(dados);
}

function encontrarLinhaCabecalho(rows, nomesContrato) {
  const limite = Math.min(rows.length, 20);

  for (let i = 0; i < limite; i++) {
    const idx = acharColuna(rows[i], nomesContrato);
    if (idx >= 0) return i;
  }

  return -1;
}

/************************************************************
 * FILTRAGEM DE DADOS POR USUÁRIO
 ************************************************************/

function filtrarDadosPorUsuario(sessao, geralRows, contabilRows, orcamentarioRows) {
  if (!geralRows || geralRows.length < 2) {
    throw new Error("Planilha geral vazia ou sem cabeçalho.");
  }

  if (!contabilRows || contabilRows.length < 1) {
    contabilRows = [[]];
  }

  if (!orcamentarioRows || orcamentarioRows.length < 1) {
    orcamentarioRows = [[]];
  }

  const headersGeral = geralRows[0];

  const idxContrato = acharColuna(headersGeral, [
    "Número Contrato",
    "Numero Contrato",
    "Nº Contrato",
    "N Contrato",
    "Contrato",
    "COL_NR_CONTR_BASE"
  ]);

  const idxSecLog = acharColuna(headersGeral, [
    "SEC_LOG",
    "SEC LOG",
    "Sec Log",
    "Seção Logística",
    "Secao Logistica"
  ]);

  const idxFornecedor = acharColuna(headersGeral, [
    "Fornecedor",
    "Favorecido",
    "Empresa",
    "Contratada"
  ]);

  const idxVigFim = acharColuna(headersGeral, [
    "Vig. Fim",
    "Vigencia Fim",
    "Vigência Fim",
    "Data Fim",
    "Vigencia Final",
    "Vigência Final"
  ]);

  const idxGestor = acharColuna(headersGeral, [
    "GESTOR_TITULAR",
    "GESTOR TITULAR",
    "Gestor Titular",
    "Gestor"
  ]);

  const idxGestorSub = acharColuna(headersGeral, [
    "GESTOR_SUBSTITUTO",
    "GESTOR SUBSTITUTO",
    "Gestor Substituto",
    "gestor_substituto"
  ]);

  const idxFiscal = acharColuna(headersGeral, [
    "FISCAL_TITULAR",
    "FISCAL TITULAR",
    "Fiscal Titular",
    "Fiscal"
  ]);

  const idxFiscalSub = acharColuna(headersGeral, [
    "FISCAL_SUBSTITUTO",
    "FISCAL SUBSTITUTO",
    "Fiscal Substituto",
    "fiscal_substituto"
  ]);

  if (idxContrato < 0) {
    throw new Error("Coluna de contrato não encontrada na planilha geral.");
  }

  const contratosPermitidos = new Set();
  const geralFiltrado = [headersGeral];

  for (let i = 1; i < geralRows.length; i++) {
    const row = geralRows[i];

    const contrato = textoDaColuna(row, idxContrato).trim();
    if (!contrato || contrato === "-") continue;

    const contexto = {
      contrato: contrato,
      secLog: textoDaColuna(row, idxSecLog).trim(),
      fornecedor: textoDaColuna(row, idxFornecedor).trim(),
      gestor: textoDaColuna(row, idxGestor).trim(),
      gestorSub: textoDaColuna(row, idxGestorSub).trim(),
      fiscal: textoDaColuna(row, idxFiscal).trim(),
      fiscalSub: textoDaColuna(row, idxFiscalSub).trim(),
      vigFim: valorDaColuna(row, idxVigFim)
    };

    const podeVer = usuarioPodeVerContrato(sessao, contexto);

    if (podeVer) {
      geralFiltrado.push(row);
      contratosPermitidos.add(normalizarContrato(contrato));
    }
  }

  const contabilFiltrado = filtrarContabilPorContratos(
    contabilRows,
    contratosPermitidos,
    sessao
  );

  const orcamentarioFiltrado = vincularOrcamentarioAoContabil(
    orcamentarioRows,
    contabilFiltrado
  );

  return {
    geral: geralFiltrado,
    contabil: contabilFiltrado,
    orcamentario: orcamentarioFiltrado
  };
}

function usuarioPodeVerContrato(sessao, contexto) {
  const perfil = normalizarPerfil(sessao.perfil);

  // ADMIN ignora todas as restrições de dados, mas ATIVO e senha já foram validados.
  if (perfil === "ADMIN") {
    return true;
  }

  if (!restricoesBasicasPermitem(sessao, contexto, perfil)) {
    return false;
  }

  if (perfil === "COLABORADOR") {
    return true;
  }

  if (perfil === "CHEFE") {
    // Regra específica: CHEFE sempre precisa obedecer SEC_LOG.
    return passaSecLogObrigatorio(sessao.sec_log, contexto.secLog);
  }

  if (perfil === "FORNECEDOR") {
    // Regra específica: FORNECEDOR sempre exige coluna FORNECEDOR preenchida e compatível.
    return passaFornecedor(sessao.fornecedor, contexto.fornecedor, false);
  }

  if (perfil === "GESTOR") {
    return usuarioApareceNosCampos(sessao.nome, [
      contexto.gestor,
      contexto.gestorSub
    ]);
  }

  if (perfil === "FISCAL") {
    return usuarioApareceNosCampos(sessao.nome, [
      contexto.fiscal,
      contexto.fiscalSub
    ]);
  }

  return false;
}

function restricoesBasicasPermitem(sessao, contexto, perfil) {
  // Para CHEFE, SEC_LOG é obrigatório e é validado depois em passaSecLogObrigatorio().
  // Para os demais perfis, SEC_LOG em branco libera.
  if (perfil !== "CHEFE") {
    if (!passaSecLog(sessao.sec_log, contexto.secLog)) return false;
  }

  // Para FORNECEDOR, FORNECEDOR é obrigatório e é validado depois em usuarioPodeVerContrato().
  // Para os demais perfis, FORNECEDOR em branco libera.
  if (perfil !== "FORNECEDOR") {
    if (!passaFornecedor(sessao.fornecedor, contexto.fornecedor, true)) return false;
  }

  if (!passaContrato(sessao.contrato, contexto.contrato)) return false;
  if (!passaVigencia(sessao.vigencia, contexto.vigFim)) return false;

  // ADMIN não chega aqui. Demais perfis respeitam VALIDADE quando indicada.
  if (!validadeAindaValida(sessao.validade_raw || sessao.validade, true)) return false;

  return true;
}

function passaSecLog(valorPermitido, secLogContrato) {
  const permissoes = listaPermissoesVirgulaOuPontoEVirgula(valorPermitido);

  if (permissoes.length === 0) return true;
  if (permissoes.includes("*")) return true;

  const secLog = normalizarPermissao(secLogContrato);
  return permissoes.includes(secLog);
}

function passaSecLogObrigatorio(valorPermitido, secLogContrato) {
  const permissoes = listaPermissoesVirgulaOuPontoEVirgula(valorPermitido);

  if (permissoes.length === 0) return false;
  if (permissoes.includes("*")) return true;

  const secLog = normalizarPermissao(secLogContrato);
  if (!secLog) return false;

  return permissoes.includes(secLog);
}

function passaFornecedor(valorPermitido, fornecedorContrato, brancoLibera) {
  const permissoes = listaPermissoesFornecedor(valorPermitido);

  if (permissoes.length === 0) return !!brancoLibera;
  if (permissoes.includes("*")) return true;

  const fornecedor = normalizarPermissao(fornecedorContrato);
  if (!fornecedor) return false;

  return permissoes.some(permissao => {
    if (!permissao) return false;

    return (
      fornecedor === permissao ||
      fornecedor.includes(permissao) ||
      permissao.includes(fornecedor)
    );
  });
}

function passaContrato(valorPermitido, contratoBase) {
  const permissoes = listaPermissoesVirgulaOuPontoEVirgula(valorPermitido)
    .map(normalizarContrato)
    .filter(Boolean);

  if (permissoes.length === 0) return true;
  if (permissoes.includes("*")) return true;

  const contrato = normalizarContrato(contratoBase);
  if (!contrato) return false;

  return permissoes.some(permissao => {
    if (!permissao) return false;

    return (
      contrato === permissao ||
      (permissao.length >= 4 && contrato.includes(permissao)) ||
      (contrato.length >= 4 && permissao.includes(contrato))
    );
  });
}

function passaVigencia(valorPermitido, valorVigenciaFinalContrato) {
  const raw = String(valorPermitido || "").trim();

  if (!raw) return true;
  if (raw === "*") return true;

  const dataReferencia = parseData(raw);

  if (!dataReferencia) {
    return false;
  }

  const dataFimContrato = parseData(valorVigenciaFinalContrato);

  if (!dataFimContrato) {
    return false;
  }

  dataReferencia.setHours(0, 0, 0, 0);
  dataFimContrato.setHours(0, 0, 0, 0);

  return dataFimContrato >= dataReferencia;
}

function filtrarContabilPorContratos(contabilRows, contratosPermitidos, sessao) {
  return filtrarLinhasPorContratos(contabilRows, contratosPermitidos, sessao);
}

function filtrarLinhasPorContratos(rows, contratosPermitidos, sessao) {
  if (!rows || rows.length < 2) {
    return rows || [[]];
  }

  const perfil = normalizarPerfil(sessao.perfil);

  // ADMIN recebe todas as linhas da fonte consultada.
  if (perfil === "ADMIN") {
    return rows;
  }

  const headers = rows[0];

  const idxContrato = acharColuna(headers, [
    "COL_NR_CONTR_BASE",
    "Contrato",
    "Número Contrato",
    "Numero Contrato"
  ]);

  const filtrado = [headers];

  if (idxContrato < 0) {
    return filtrado;
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const contrato = normalizarContrato(textoDaColuna(row, idxContrato));

    if (contratosPermitidos.has(contrato)) {
      filtrado.push(row);
    }
  }

  return filtrado;
}

function vincularOrcamentarioAoContabil(orcamentarioRows, contabilRows) {
  if (!orcamentarioRows || !orcamentarioRows.length) return [[]];
  const hOrc = orcamentarioRows[0] || [];
  const hCont = contabilRows && contabilRows.length ? contabilRows[0] : [];
  const acharExata = (headers, names) => {
    const normalized = headers.map(normalizarBuscaCompacta);
    for (const name of names) {
      const index = normalized.indexOf(normalizarBuscaCompacta(name));
      if (index >= 0) return index;
    }
    return -1;
  };
  const nomesDoc = ["Documento CCor Número", "Documento CCor Numero", "DOCUMENTO_CCOR_NUMERO"];
  const nomesContrato = ["COL_NR_CONTR_BASE", "Contrato", "Número Contrato", "Numero Contrato"];
  // Only compare like-for-like issuer columns; an executing UG may differ from
  // the document issuer, so it is deliberately not treated as the same field.
  const nomesEmitente = ["Emitente - UG Código", "Emitente - UG Codigo", "Emitente UG Código", "Emitente UG Codigo", "UG Emitente Código", "UG Emitente Codigo"];
  const idxDocOrc = acharExata(hOrc, nomesDoc);
  const idxDocCont = acharExata(hCont, nomesDoc);
  const idxContratoCont = acharExata(hCont, nomesContrato);
  const idxContratoOrc = acharExata(hOrc, nomesContrato);
  const idxEmitenteOrc = acharExata(hOrc, nomesEmitente);
  const idxEmitenteCont = acharExata(hCont, nomesEmitente);
  const headers = hOrc.slice();
  let idxContratoResultado = acharExata(headers, ["COL_NR_CONTR_BASE"]);
  if (idxContratoResultado < 0) {
    idxContratoResultado = headers.length;
    headers.push("COL_NR_CONTR_BASE");
  }
  const resultado = [headers];
  resultado.diagnosticoVinculos = { vinculados: 0, ambiguos: 0, semVinculo: 0, colunasAusentes: false };
  if (idxDocOrc < 0 || idxDocCont < 0 || idxContratoCont < 0) {
    resultado.diagnosticoVinculos.colunasAusentes = true;
    return resultado;
  }
  // Candidates come exclusively from the accounting rows already authorized
  // by filtrarDadosPorUsuario. A source contract never widens access.
  const porDocumento = new Map();
  for (let i = 1; i < contabilRows.length; i++) {
    const row = contabilRows[i];
    const documento = normalizarDocumentoCcor(textoDaColuna(row, idxDocCont));
    const contrato = textoDaColuna(row, idxContratoCont).trim();
    if (!documento || !contrato || contrato === "-") continue;
    if (!porDocumento.has(documento)) porDocumento.set(documento, new Map());
    const idContrato = normalizarContrato(contrato);
    const contratos = porDocumento.get(documento);
    if (!contratos.has(idContrato)) contratos.set(idContrato, { contrato: contrato, emitentes: new Set() });
    const emitente = normalizarDocumentoCcor(textoDaColuna(row, idxEmitenteCont));
    if (emitente) contratos.get(idContrato).emitentes.add(emitente);
  }
  for (let i = 1; i < orcamentarioRows.length; i++) {
    const row = orcamentarioRows[i];
    const documento = normalizarDocumentoCcor(textoDaColuna(row, idxDocOrc));
    const contratos = porDocumento.get(documento);
    if (!documento || !contratos) { resultado.diagnosticoVinculos.semVinculo++; continue; }
    const contratoOrigem = normalizarContrato(textoDaColuna(row, idxContratoOrc));
    const emitenteOrigem = normalizarDocumentoCcor(textoDaColuna(row, idxEmitenteOrc));
    let candidatos = Array.from(contratos.entries());
    if (contratoOrigem && contratoOrigem !== "-") candidatos = candidatos.filter(item => item[0] === contratoOrigem);
    if (emitenteOrigem && idxEmitenteCont >= 0) candidatos = candidatos.filter(item => item[1].emitentes.has(emitenteOrigem));
    if (candidatos.length !== 1) {
      if (candidatos.length > 1) resultado.diagnosticoVinculos.ambiguos++;
      else resultado.diagnosticoVinculos.semVinculo++;
      continue;
    }
    const vinculada = row.slice();
    while (vinculada.length < headers.length) vinculada.push("");
    vinculada[idxContratoResultado] = candidatos[0][1].contrato;
    resultado.push(vinculada);
    resultado.diagnosticoVinculos.vinculados++;
  }
  return resultado;
}

function normalizarDocumentoCcor(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

/************************************************************
 * LISTAS E PERMISSÕES
 ************************************************************/

function listaPermissoesVirgulaOuPontoEVirgula(valor) {
  return String(valor || "")
    .split(/[;,\n|]+/)
    .map(v => normalizarPermissao(v))
    .filter(Boolean);
}

function listaPermissoesFornecedor(valor) {
  // Mantém a regra anterior: fornecedor NÃO usa vírgula como separador,
  // porque nomes empresariais podem conter vírgula.
  return String(valor || "")
    .split(/[;\n|]+/)
    .map(v => normalizarPermissao(v))
    .filter(Boolean);
}

function usuarioApareceNosCampos(nomeUsuario, campos) {
  const nome = normalizarNomeCaseSensitive(nomeUsuario);
  if (!nome) return false;

  return campos.some(campo => {
    const texto = normalizarNomeCaseSensitive(campo);
    if (!texto) return false;

    // NOME é case-sensitive: não converte para maiúsculo/minúsculo.
    return texto.includes(nome);
  });
}

/************************************************************
 * DATAS: VALIDADE E VIGÊNCIA
 ************************************************************/

function validadeAindaValida(valorValidade, brancoLibera) {
  const raw = valorOriginalData(valorValidade);

  if (!raw) return !!brancoLibera;
  if (raw === "*") return true;

  const dataValidade = parseData(raw);

  if (!dataValidade) {
    return false;
  }

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  dataValidade.setHours(0, 0, 0, 0);

  return dataValidade >= hoje;
}

function parseData(valor) {
  if (!valor) return null;

  if (valor instanceof Date) {
    return new Date(valor.getTime());
  }

  if (typeof valor === "number") {
    return new Date(Math.round((valor - 25569) * 86400 * 1000));
  }

  const txt = String(valor).trim();

  if (!txt) return null;

  // dd/mm/aaaa
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(txt)) {
    const partes = txt.split("/");
    const dia = Number(partes[0]);
    const mes = Number(partes[1]) - 1;
    const ano = Number(partes[2]);
    return new Date(ano, mes, dia);
  }

  // aaaa-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) {
    return new Date(txt + "T00:00:00");
  }

  const data = new Date(txt);
  return isNaN(data.getTime()) ? null : data;
}

function formatarDataParaTexto(valor) {
  const data = parseData(valor);
  if (!data) return "";

  const dia = String(data.getDate()).padStart(2, "0");
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const ano = data.getFullYear();

  return `${dia}/${mes}/${ano}`;
}

function valorOriginalData(valor) {
  if (!valor) return "";

  if (valor instanceof Date) {
    return formatarDataParaTexto(valor);
  }

  return String(valor || "").trim();
}

/************************************************************
 * DIAGNÓSTICO
 ************************************************************/

function diagnosticarCabecalhos() {
  const geralRows = lerRange(CONFIG.SPREADSHEET_ID_GERAL, CONFIG.RANGE_GERAL, true);
  const contabilRows = lerRange(CONFIG.SPREADSHEET_ID_CONTABIL, CONFIG.RANGE_CONTABIL);
  const orcamentarioRows = lerAbaPorGid(
    CONFIG.SPREADSHEET_ID_ORCAMENTARIO,
    CONFIG.SHEET_GID_ORCAMENTARIO
  );

  return respostaJson({
    ok: true,
    mensagem: "Diagnóstico das primeiras linhas das planilhas.",
    revisao: REVISAO_API,
    geral: resumoPrimeirasLinhas(geralRows, 8),
    contabil: resumoPrimeirasLinhas(contabilRows, 8),
    orcamentario: resumoPrimeirasLinhas(orcamentarioRows, 8)
  });
}

function resumoPrimeirasLinhas(rows, qtdLinhas) {
  return rows.slice(0, qtdLinhas).map((row, idx) => {
    return {
      linha: idx + 1,
      valores: row.map((valor, colIdx) => {
        return {
          coluna: colIdx + 1,
          valor: valor instanceof Date ? formatarDataParaTexto(valor) : String(valor || "")
        };
      }).filter(item => item.valor !== "")
    };
  });
}

/************************************************************
 * AJUDAS DE COLUNA E TEXTO
 ************************************************************/

function acharColuna(headers, nomesPossiveis) {
  if (!headers || !headers.length || !nomesPossiveis || !nomesPossiveis.length) return -1;

  const headersNorm = headers.map(h => normalizarBusca(h));
  const headersCompactos = headers.map(h => normalizarBuscaCompacta(h));
  const nomesNorm = nomesPossiveis.map(n => normalizarBusca(n)).filter(Boolean);
  const nomesCompactos = nomesPossiveis.map(n => normalizarBuscaCompacta(n)).filter(Boolean);

  for (const nome of nomesNorm) {
    const idx = headersNorm.indexOf(nome);
    if (idx >= 0) return idx;
  }
  for (const nome of nomesCompactos) {
    const idx = headersCompactos.indexOf(nome);
    if (idx >= 0) return idx;
  }
  for (const nome of nomesCompactos) {
    if (nome.length < 4) continue;
    // A blank header must never match a nonempty name by substring.
    const idx = headersCompactos.findIndex(h => h.length >= 4 && (h.includes(nome) || nome.includes(h)));
    if (idx >= 0) return idx;
  }

  // Contract aliases are a fallback only for a contract-column request.
  // They must not turn an absent SEC_LOG, gestor or other field into a contract.
  const procuraContrato = nomesCompactos.some(nome =>
    /^(?:contrato|numerocontrato|numerocontratobase|ncontrato|nrcontrato|nrcontratobase|colnrcontrbase)$/.test(nome)
  );
  if (!procuraContrato) return -1;
  return headersCompactos.findIndex(h => h && (
    h === "numerocontrato" || h === "ncontrato" || h === "nrcontrato" || h === "colnrcontrbase" ||
    h.includes("numerocontrato") || h.includes("contrbase")
  ));
}

function valorDaColuna(row, idx) {
  if (idx < 0) return "";
  return row[idx];
}

function textoDaColuna(row, idx) {
  if (idx < 0) return "";
  const valor = row[idx];
  if (valor === null || valor === undefined) return "";
  return String(valor);
}

function normalizarCabecalho(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, "_");
}

function normalizarBusca(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\-.\/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function normalizarBuscaCompacta(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .trim();
}

function normalizarLogin(valor) {
  // USUARIO é case-sensitive. Mantém maiúsculas/minúsculas e acentos.
  return String(valor || "").trim();
}

function normalizarNomeCaseSensitive(valor) {
  // NOME é case-sensitive. Apenas remove espaços extras nas pontas e duplica espaços internos.
  return String(valor || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizarTexto(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function normalizarPerfil(valor) {
  const perfil = normalizarTexto(valor);

  // Aceita erro comum de digitação.
  if (perfil === "GESGOR") return "GESTOR";

  return perfil;
}

function normalizarPermissao(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
}

function normalizarContrato(valor) {
  const raw = String(valor || "").trim();
  if (raw === "*") return "*";

  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

/************************************************************
 * JSON E POST
 ************************************************************/

function serializarLinhasParaJson(rows) {
  if (!rows) return [];

  return rows.map(row => {
    return row.map(cell => {
      if (cell instanceof Date) {
        return formatarDataParaTexto(cell);
      }

      if (cell === null || cell === undefined) {
        return "";
      }

      return cell;
    });
  });
}

function respostaJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function obterBodyPost(e) {
  if (e && e.parameter && Object.keys(e.parameter).length > 0) {
    return e.parameter;
  }

  if (e && e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (erro) {
      return {};
    }
  }

  return {};
}

/************************************************************
 * FUNÇÕES LOCAIS DE TESTE OPCIONAIS
 ************************************************************/

function testarCabecalhosLocal() {
  const resposta = doGet({ parameter: { acao: "cabecalhos" } });
  Logger.log(resposta.getContent());
}

function testarStatusLocal() {
  const resposta = doGet({ parameter: { acao: "status" } });
  Logger.log(resposta.getContent());
}

function testarLoginLocal() {
  const resposta = login({
    acao: "login",
    usuario: "admin",
    senha: "123456"
  });
  Logger.log(resposta.getContent());
}

function logDuracao(segundos) {
  // LOG_ACESSO: identidade, horário e saldos vêm do servidor; não grava credenciais.
  const total = Math.max(0, Math.floor(segundos));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map(valor => String(valor).padStart(2, "0")).join(":");
}

function logResumo(sessao, instante, controleAcesso) {
  const admin = normalizarPerfil(sessao.perfil) === "ADMIN";
  const limite = admin ? null : parseInteiroPositivo(sessao.acessos_diarios);
  const dia = Utilities.formatDate(instante, Session.getScriptTimeZone(), "yyyyMMdd");
  const usados = Number(PropertiesService.getScriptProperties().getProperty("acessos_" + sessao.usuario + "_" + dia) || "0");
  const restantes = limite === null ? "SEM LIMITE" :
    (controleAcesso && Number.isFinite(controleAcesso.restantes) ? controleAcesso.restantes : Math.max(0, limite - usados));
  const horas = admin ? null : Number(sessao.duracao_diaria_horas);
  const temDuracao = horas > 0 && Number(sessao.expiraEm) > 0;
  return [limite === null ? "SEM LIMITE" : limite, restantes,
    temDuracao ? logDuracao(horas * 3600) : "SEM LIMITE",
    temDuracao ? logDuracao((Number(sessao.expiraEm) - instante.getTime()) / 1000) : "SEM LIMITE"];
}

function logHash(texto) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto, Utilities.Charset.UTF_8)
    .map(byte => ((byte + 256) % 256).toString(16).padStart(2, "0")).join("");
}

function logIdValido(valor) {
  return typeof valor === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(valor);
}

function logGravar(sessao, evento, eventoId, controleAcesso) {
  const eventos = ["ACESSO_INCIAL", "SINCRONIZACAO_API", "SAIR", "FECHAR_TELA", "ATUALIZAR_TELA"];
  if (!sessao || !sessao.usuario || !eventos.includes(evento) || !logIdValido(eventoId)) {
    return { ok: false, mensagem: "Evento de acesso inválido." };
  }
  const instante = new Date();
  const lock = LockService.getScriptLock();
  let travado = false;
  try {
    lock.waitLock(10000); travado = true;
    const props = PropertiesService.getScriptProperties();
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID_LOG_ACESSO).getSheetByName(CONFIG.ABA_LOG_ACESSO);
    if (!sheet) throw new Error("Aba LOG_ACESSO não encontrada.");
    const esperados = ["DATA", "HORA", "USUARIO", "EVENTO", "ACESSO_DIARIO_PREVISTO", "ACESSO_DIARIO_RESTANTE", "DURACAO_DIARIA_PREVISTA", "DURACAO_DIARIA_RESTANTE"];
    const headers = sheet.getRange(1, 1, 1, 8).getValues()[0].map(normalizarCabecalho);
    if (!esperados.every((header, i) => header === headers[i])) throw new Error("Conferir cabeçalhos A:H de LOG_ACESSO.");
    // Index bounded to 40 events per user; recent retries and reload/close pairs
    // share an ID. Row notes preserve identity if the sheet is sorted manually.
    const usuarioHash = logHash(sessao.usuario), identidade = logHash(sessao.usuario + "|" + eventoId);
    const chave = "log_indice_" + usuarioHash;
    let indice;
    try { indice = JSON.parse(props.getProperty(chave) || "[]"); } catch (_) { indice = []; }
    if (!Array.isArray(indice)) indice = [];
    indice = indice.filter(item => item && typeof item.id === "string" && Number.isInteger(item.row));
    const anterior = indice.find(item => item.id === identidade);
    let linha = anterior ? anterior.row : 0, eventoAnterior = "";
    if (linha) {
      if (linha > sheet.getLastRow() || sheet.getRange(linha, 4).getNote().split("\n")[0] !== identidade) {
        const quantidade = Math.max(0, sheet.getLastRow() - 1);
        const notas = quantidade ? sheet.getRange(2, 4, quantidade, 1).getNotes() : [];
        const posicao = notas.findIndex(nota => String(nota[0] || "").split("\n")[0] === identidade);
        linha = posicao < 0 ? 0 : posicao + 2;
      }
      if (linha) {
        eventoAnterior = String(sheet.getRange(linha, 4).getValue());
        // Reload wins regardless of whether its request or pagehide arrives first.
        if (!(eventoAnterior === "FECHAR_TELA" && evento === "ATUALIZAR_TELA")) {
          return { ok: true, duplicado: true };
        }
      }
    }
    const resumo = logResumo(sessao, instante, controleAcesso);
    const valores = [Utilities.formatDate(instante, CONFIG.FUSO_LOG_ACESSO, "dd/MM/yyyy"),
      Utilities.formatDate(instante, CONFIG.FUSO_LOG_ACESSO, "HH:mm:ss"),
      String(sessao.usuario), evento, ...resumo];
    // Plain text prevents usernames from being interpreted as spreadsheet formulas.
    valores[2] = /^\s*[=+@-]/.test(valores[2]) ? "'" + valores[2] : valores[2];
    if (!linha) linha = Math.max(2, sheet.getLastRow() + 1);
    if (linha > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(100, linha - sheet.getMaxRows()));
    const range = sheet.getRange(linha, 1, 1, 8);
    range.setNumberFormats([["@", "@", "@", "@", "0", "0", "@", "@"]]);
    range.setValues([valores]);
    sheet.getRange(linha, 4).setNote(identidade + (evento === "FECHAR_TELA" ?
      "\nIndicação aproximada de saída da página. Pode ser fechamento ou navegação; o navegador não confirma o fechamento. Um recarregamento correlacionado substitui este evento por ATUALIZAR_TELA." : "\nEvento autenticado. Horário e saldos calculados pelo servidor."));
    SpreadsheetApp.flush();
    indice = indice.filter(item => item.id !== identidade);
    indice.push({ id: identidade, row: linha });
    props.setProperty(chave, JSON.stringify(indice.slice(-40)));
    return { ok: true, corrigido: eventoAnterior === "FECHAR_TELA" };
  } catch (erro) {
    console.error("Falha ao registrar LOG_ACESSO: " + erro.message);
    return { ok: false, mensagem: "Não foi possível gravar o log de acesso. Confira a aba LOG_ACESSO e as permissões da API." };
  } finally {
    if (travado) lock.releaseLock();
  }
}

function logEventoDaCarga(parametros, sessao, controleAcesso) {
  const evento = String(parametros.evento || "");
  if (!["SINCRONIZACAO_API", "ATUALIZAR_TELA"].includes(evento)) return null;
  return logGravar(sessao, evento, parametros.evento_id, controleAcesso);
}

function logEventoDoNavegador(body) {
  const evento = String(body.evento || "");
  if (!["SAIR", "FECHAR_TELA"].includes(evento) || !logIdValido(body.evento_id)) {
    return respostaJson({ ok: false, mensagem: "Evento de navegador inválido." });
  }
  const token = typeof body.token === "string" && body.token.length <= 256 ? body.token : "";
  const props = PropertiesService.getScriptProperties();
  const raw = token ? props.getProperty("sessao_" + token) : null;
  if (!raw) return respostaJson({ ok: false, mensagem: "Sessão não encontrada." });
  const sessao = JSON.parse(raw);
  // Allow an existing expired session to report leaving with 00:00:00 remaining.
  // This route cannot return dashboard data, extend sessions or consume quota.
  const usuario = buscarUsuarioPorLogin(sessao.usuario);
  if (usuario) { sessao.perfil = normalizarPerfil(usuario.PERFIL); sessao.acessos_diarios = String(usuario.ACESSOS_DIARIOS || ""); }
  const resultado = logGravar(sessao, evento, body.evento_id);
  if (evento === "SAIR") props.deleteProperty("sessao_" + token);
  return respostaJson(resultado);
}
