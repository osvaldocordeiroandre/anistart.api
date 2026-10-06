import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import puppeteer from "puppeteer";

const JSON_FILE = path.resolve("public/Schedule.json");
const IMAGES_DIR = path.resolve("public/imagens_animes");
const VERCEL_SYNC_FILE = path.resolve(".vercel-sync-scraping");

// Modo incremental (padrão): só abre a página interna de animes novos ou sem dados.
// FULL_REFRESH=true reabre todas as páginas internas (títulos, plataformas e imagens).
const FULL_REFRESH = process.env.FULL_REFRESH === "true";

// O Cloudflare do aniquim bloqueia:
//  - o User-Agent "HeadlessChrome" padrão do Puppeteer
//  - o fetch do Node (pela "impressão digital" TLS), mesmo com User-Agent de navegador
//  - a sessão inteira depois que o JS do Cloudflare roda e detecta o headless (cookie cf_clearance)
// Por isso: User-Agent de navegador, JavaScript desativado (o site já vem renderizado do servidor)
// e imagens baixadas pelo próprio Chrome.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// ==========================================
// 0. FUNÇÕES AUXILIARES
// ==========================================
function limparNomeArquivo(nome) {
  if (!nome) return "imagem_sem_nome";
  return nome.replace(/[\\/*?:"<>|]/g, ""); // Remove caracteres inválidos
}

const delay = (min, max) => {
  const ms = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// Baixa usando o fetch de dentro da página (TLS do Chrome) e devolve em base64
async function downloadImagem(page, url, filepath) {
  try {
    const { status, base64 } = await page.evaluate(async (u) => {
      const response = await fetch(u);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binario = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return { status: response.status, base64: btoa(binario) };
    }, url);
    if (status !== 200) throw new Error(`HTTP error! status: ${status}`);
    fs.writeFileSync(filepath, Buffer.from(base64, "base64"));
  } catch (e) {
    console.error(`  -> Erro ao baixar imagem: ${e.message}`);
  }
}

// Títulos e plataformas de streaming da página interna do anime
function extrairPaginaInterna(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector('h1[data-slot="text"]');
    const titulo_en = h1 ? h1.textContent.trim() : null;

    const pTags = document.querySelectorAll('p[data-slot="text"]');
    let titulo = null;
    let titulo_jp = null;

    pTags.forEach((p) => {
      if (p.classList.contains("min-w-0")) titulo_jp = p.textContent.trim();
      else if (
        p.classList.contains("truncate") &&
        p.classList.contains("leading-none")
      )
        titulo = p.textContent.trim();
    });

    const plataformas = [];
    const tagsStreaming = document.querySelectorAll("a[href]");
    tagsStreaming.forEach((a) => {
      const titleAttr =
        a.getAttribute("title") || a.getAttribute("aria-label") || "";
      if (
        titleAttr.includes("Assistir em") ||
        titleAttr.includes("Crunchyroll") ||
        titleAttr.includes("Netflix")
      ) {
        const nome = titleAttr
          .replace("Assistir em ", "")
          .replace(" (BR)", "")
          .trim();
        const link = a.getAttribute("href");
        const svg = a.querySelector("svg");

        if (!plataformas.find((p) => p.nome === nome)) {
          plataformas.push({
            nome,
            link_streaming: link,
            icone_svg: svg ? svg.outerHTML : null,
          });
        }
      }
    });

    return { titulo, titulo_en, titulo_jp, plataformas };
  });
}

// ==========================================
// 1. FLUXO PRINCIPAL DE SCRAPING
// ==========================================
async function runScraping() {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true }); // Cria pasta de imagens se não existir
  }

  console.log("Iniciando o navegador Puppeteer...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // Configurações otimizadas para GitHub Actions[cite: 2]
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  });
  await page.setJavaScriptEnabled(false);

  const urlPrincipal = "https://www.aniquim.com.br/animes/programacao";
  console.log(`Acessando página principal: ${urlPrincipal}`);

  await page.goto(urlPrincipal, { waitUntil: "domcontentloaded" });
  await delay(1, 2);

  const tituloPagina = await page.title();
  console.log(`Título da página: ${tituloPagina}`);

  // PASSO 1: Extrair e agrupar os cartões[cite: 1]
  // PASSO 1: Extrair e agrupar os cartões
  let schedule = await page.evaluate(() => {
    const data = {
      Monday: [],
      Tuesday: [],
      Wednesday: [],
      Thursday: [],
      Friday: [],
      Saturday: [],
      Sunday: [],
      Outros: [],
    };

    // Pega todos os possíveis textos de dias da semana E os cartões na ordem do documento
    const elementos = document.querySelectorAll(
      'h1, h2, h3, h4, div[data-slot="text"], span, p, div[data-slot="card"]',
    );

    let diaAtual = "Outros";

    elementos.forEach((el) => {
      // Se o elemento for um Cartão de anime, extraímos os dados e colocamos no diaAtual
      if (el.matches('div[data-slot="card"]')) {
        const cartao = el;

        const linkEl = cartao.querySelector('a[href^="/anime/"]');
        let linkRaw = linkEl ? linkEl.getAttribute("href") : null;
        let linkCompleto =
          linkRaw && linkRaw.startsWith("/")
            ? "https://www.aniquim.com.br" + linkRaw
            : linkRaw;

        const imgEl = cartao.querySelector('a[href^="/anime/"] img');
        let imagem = imgEl ? imgEl.getAttribute("src") : null;
        if (!imagem && imgEl) {
          const srcset = imgEl.getAttribute("srcset");
          if (srcset) imagem = srcset.split(",")[0].split(" ")[0];
        }

        const episodioEl = cartao.querySelector(
          ".absolute.bottom-3.right-3 span.font-serif",
        );
        const episodio = episodioEl ? episodioEl.textContent.trim() : null;

        const horarioEl = cartao.querySelector(
          "div.items-baseline > span.font-bold",
        );
        const horario = horarioEl ? horarioEl.textContent.trim() : null;

        let tagsEl =
          cartao.querySelector(
            'h3[data-slot="text"] + span.text-theme-muted',
          ) || cartao.querySelector("div.flex-col > span.truncate");
        const tags = tagsEl ? tagsEl.textContent.trim() : null;

        const titleEl = cartao.querySelector('h3[data-slot="text"]');
        const title_provisorio = titleEl ? titleEl.textContent.trim() : null;

        if (linkCompleto) {
          data[diaAtual].push({
            title_provisorio,
            page: linkCompleto,
            image_url: imagem,
            time: horario,
            episodio_atual: episodio,
            tags_generos: tags,
          });
        }
      } else {
        // Se o elemento não for um cartão, verificamos se o texto dele é um dia da semana
        const texto = el.textContent.toLowerCase().trim();
        // Filtra textos muito grandes para não confundir com sinopses
        if (texto.length > 0 && texto.length < 30) {
          if (texto.includes("segunda")) diaAtual = "Monday";
          else if (texto.includes("terça") || texto.includes("terca"))
            diaAtual = "Tuesday";
          else if (texto.includes("quarta")) diaAtual = "Wednesday";
          else if (texto.includes("quinta")) diaAtual = "Thursday";
          else if (texto.includes("sexta")) diaAtual = "Friday";
          else if (texto.includes("sábado") || texto.includes("sabado"))
            diaAtual = "Saturday";
          else if (texto.includes("domingo")) diaAtual = "Sunday";
        }
      }
    });

    // Remove os dias que não tiverem nenhum anime
    Object.keys(data).forEach((k) => {
      if (data[k].length === 0) delete data[k];
    });
    return data;
  });

  const totalAnimes = Object.values(schedule).reduce(
    (acc, curr) => acc + curr.length,
    0,
  );
  console.log(`Encontrados ${totalAnimes} animes agrupados por dia.`);

  // Se veio bloqueado (Cloudflare) ou o layout mudou, aborta sem tocar no JSON
  if (totalAnimes === 0) {
    await browser.close();
    throw new Error(
      `Nenhum anime encontrado (título da página: "${tituloPagina}"). Possível bloqueio do Cloudflare.`,
    );
  }

  // Lê o JSON atual para reaproveitar dados caso alguma página interna falhe
  let jsonExistente = { schedule: {} };
  if (fs.existsSync(JSON_FILE)) {
    try {
      jsonExistente = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
    } catch (e) {
      console.error("Erro ao ler JSON existente, criando um novo.", e.message);
    }
  }
  const antigosPorPagina = new Map();
  Object.values(jsonExistente.schedule || {})
    .flat()
    .forEach((a) => a.page && antigosPorPagina.set(a.page, a));

  console.log(
    FULL_REFRESH
      ? "Modo completo: reabrindo todas as páginas internas."
      : "Modo incremental: abrindo só as páginas internas de animes novos.",
  );

  // PASSO 2: Monta cada anime, reaproveitando os dados internos que já temos
  for (const [dia, animes] of Object.entries(schedule)) {
    for (const [i, cartao] of animes.entries()) {
      const antigo = antigosPorPagina.get(cartao.page);
      const imagemAntigaExiste =
        antigo?.local_image_path &&
        fs.existsSync(
          path.join(IMAGES_DIR, path.win32.basename(antigo.local_image_path)),
        );
      const reaproveitar =
        !FULL_REFRESH &&
        antigo &&
        (antigo.titulo_en || antigo.titulo) &&
        imagemAntigaExiste;

      let internos;
      if (reaproveitar) {
        internos = antigo;
      } else {
        console.log(`[${dia}] Acessando: ${cartao.title_provisorio}...`);
        await page.goto(cartao.page, { waitUntil: "domcontentloaded" });
        await delay(3, 5);
        internos = await extrairPaginaInterna(page);

        if (!internos.titulo_en && !internos.titulo) {
          console.warn(
            `  -> Página interna sem dados (${await page.title()}), reaproveitando dados antigos.`,
          );
        }
        internos = {
          titulo:
            internos.titulo || antigo?.titulo || cartao.title_provisorio,
          titulo_en: internos.titulo_en || antigo?.titulo_en || null,
          titulo_jp: internos.titulo_jp || antigo?.titulo_jp || null,
          plataformas: internos.plataformas.length
            ? internos.plataformas
            : antigo?.plataformas || [],
        };
      }

      // Mesma ordem de chaves do JSON salvo, para a comparação de mudanças ser estável
      const anime = {
        page: cartao.page,
        image_url: cartao.image_url,
        time: cartao.time,
        episodio_atual: cartao.episodio_atual,
        tags_generos: cartao.tags_generos,
        titulo: internos.titulo,
        titulo_en: internos.titulo_en,
        titulo_jp: internos.titulo_jp,
        plataformas: internos.plataformas,
      };

      // PASSO 3: Baixar a imagem (nova, inexistente ou com capa trocada no site)
      let urlImagem = anime.image_url;
      if (urlImagem) {
        if (urlImagem.startsWith("/")) {
          urlImagem = `https://www.aniquim.com.br${urlImagem}`;
        }

        const nomeBase =
          anime.titulo_en || anime.titulo || "imagem_desconhecida";
        const nomeArquivo = limparNomeArquivo(nomeBase);
        // Mantém o separador "\" que o app já consome (gerado pela versão Python no Windows)
        const relativeImgPath = "imagens_animes\\" + nomeArquivo + ".jpg";
        const absoluteImgPath = path.join(IMAGES_DIR, `${nomeArquivo}.jpg`);

        const capaMudou = antigo && antigo.image_url !== anime.image_url;
        if (FULL_REFRESH || capaMudou || !fs.existsSync(absoluteImgPath)) {
          console.log(`  -> Baixando imagem: ${nomeArquivo}.jpg`);
          await downloadImagem(page, urlImagem, absoluteImgPath);
        }

        anime.local_image_path = relativeImgPath;
      } else if (antigo?.local_image_path) {
        anime.local_image_path = antigo.local_image_path;
      }

      animes[i] = anime;
    }
  }

  await browser.close();

  // PASSO 4: Substitui a programação inteira (igual à versão Python).
  // O merge antigo nunca removia animes que saíram da grade nem os que mudaram de dia.
  // Se nada mudou, não grava nada (evita commit e deploy na Vercel à toa).
  if (JSON.stringify(schedule) === JSON.stringify(jsonExistente.schedule)) {
    console.log("\nNenhuma mudança na programação.");
    return false;
  }

  const resultadoFinal = {
    updatedAt: new Date().toISOString(),
    schedule,
  };

  if (!fs.existsSync(path.dirname(JSON_FILE)))
    fs.mkdirSync(path.dirname(JSON_FILE), { recursive: true });
  fs.writeFileSync(JSON_FILE, JSON.stringify(resultadoFinal, null, 2), "utf8");

  console.log("\nSucesso! Programação atualizada.");
  return true;
}

// ==========================================
// 2. INTEGRAÇÃO GIT / VERCEL (Similar ao sync-animes)
// ==========================================
async function main() {
  const mudou = await runScraping();
  if (!mudou) return;

  // Commit no Git[cite: 2]
  fs.writeFileSync(
    VERCEL_SYNC_FILE,
    `Last sync scraping: ${new Date().toISOString()}`,
  );

  try {
    // Verifica se houve alguma alteração (para não commitar vazio)
    const status = execSync("git status --porcelain").toString();
    if (!status) {
      console.log("\nSem mudanças nos dados de programação para commitar.");
      return;
    }

    execSync(
      "git add public/Schedule.json public/imagens_animes .vercel-sync-scraping",
    );
    execSync('git commit -m "chore: atualiza schedule e imagens via scraping"');
    // Traz commits feitos enquanto o scraping rodava (ex.: push manual) antes de enviar
    execSync("git pull --rebase");
    execSync("git push");
    console.log("🚀 Dados de scraping sincronizados e commitados no GitHub!");
  } catch (error) {
    console.error("Erro ao fazer commit/push do scraping:", error.message);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1); // Faz o GitHub Actions marcar a execução como falha
});
