import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import puppeteer from "puppeteer";

const JSON_FILE = path.resolve("public/Schedule.json");
const IMAGES_DIR = path.resolve("public/imagens_animes");
const VERCEL_SYNC_FILE = path.resolve(".vercel-sync-scraping");

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

async function downloadImagem(url, filepath) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(filepath, buffer);
  } catch (e) {
    console.error(`  -> Erro ao baixar imagem: ${e.message}`);
  }
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

  const urlPrincipal = "https://www.aniquim.com.br/animes/programacao";
  console.log(`Acessando página principal: ${urlPrincipal}`);

  await page.goto(urlPrincipal, { waitUntil: "domcontentloaded" });
  await delay(5, 7); // Pausa aleatória igual ao Python[cite: 1]

  // PASSO 1: Extrair e agrupar os cartões[cite: 1]
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
    const cartoes = document.querySelectorAll('div[data-slot="card"]');

    cartoes.forEach((cartao) => {
      let prev = cartao.previousElementSibling;
      let textoDia = "";
      while (prev) {
        if (prev.matches('div[data-slot="text"]')) {
          textoDia = prev.textContent.toLowerCase().trim();
          break;
        }
        prev = prev.previousElementSibling;
      }

      let diaSemana = "Outros";
      if (textoDia.includes("segunda")) diaSemana = "Monday";
      else if (textoDia.includes("terça") || textoDia.includes("terca"))
        diaSemana = "Tuesday";
      else if (textoDia.includes("quarta")) diaSemana = "Wednesday";
      else if (textoDia.includes("quinta")) diaSemana = "Thursday";
      else if (textoDia.includes("sexta")) diaSemana = "Friday";
      else if (textoDia.includes("sábado") || textoDia.includes("sabado"))
        diaSemana = "Saturday";
      else if (textoDia.includes("domingo")) diaSemana = "Sunday";

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
        cartao.querySelector('h3[data-slot="text"] + span.text-theme-muted') ||
        cartao.querySelector("div.flex-col > span.truncate");
      const tags = tagsEl ? tagsEl.textContent.trim() : null;

      const titleEl = cartao.querySelector('h3[data-slot="text"]');
      const title_provisorio = titleEl ? titleEl.textContent.trim() : null;

      if (linkCompleto) {
        data[diaSemana].push({
          title_provisorio,
          page: linkCompleto,
          image_url: imagem,
          time: horario,
          episodio_atual: episodio,
          tags_generos: tags,
        });
      }
    });

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

  // PASSO 2: Iterar sobre os dias e os animes[cite: 1]
  for (const [dia, animes] of Object.entries(schedule)) {
    console.log(`\n--- Processando animes de ${dia} ---`);
    for (let anime of animes) {
      console.log(`Acessando: ${anime.title_provisorio}...`);
      await page.goto(anime.page, { waitUntil: "domcontentloaded" });
      await delay(3, 5); //[cite: 1]

      const dadosInternos = await page.evaluate(() => {
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

      anime.titulo = dadosInternos.titulo;
      anime.titulo_en = dadosInternos.titulo_en;
      anime.titulo_jp = dadosInternos.titulo_jp;
      anime.plataformas = dadosInternos.plataformas;
      delete anime.title_provisorio;

      // PASSO 3: Baixar a imagem[cite: 1]
      let urlImagem = anime.image_url;
      if (urlImagem) {
        if (urlImagem.startsWith("/"))
          urlImagem = `https://www.aniquim.com.br${urlImagem}`;

        const nomeBase =
          anime.titulo_en || anime.titulo || "imagem_desconhecida";
        const nomeArquivo = limparNomeArquivo(nomeBase);
        const relativeImgPath = path.join(
          "imagens_animes",
          `${nomeArquivo}.jpg`,
        );
        const absoluteImgPath = path.resolve("public", relativeImgPath);

        await downloadImagem(urlImagem, absoluteImgPath);
        anime.local_image_path = relativeImgPath;
      }
    }
  }

  await browser.close();

  // PASSO 4: Ler o histórico e fazer MERGE dos dados
  let jsonExistente = { schedule: {} };

  // Lê o JSON atual para não perder os dados antigos (como no sync-animes.js)
  if (fs.existsSync(JSON_FILE)) {
    try {
      jsonExistente = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
    } catch (e) {
      console.error("Erro ao ler JSON existente, criando um novo.", e.message);
    }
  }

  // Compara e mescla os dados extraídos com os dados salvos
  for (const [dia, animesNovos] of Object.entries(schedule)) {
    if (!jsonExistente.schedule[dia]) {
      jsonExistente.schedule[dia] = [];
    }

    for (const animeNovo of animesNovos) {
      // Busca o anime no banco existente pelo título (em inglês ou normal)
      const index = jsonExistente.schedule[dia].findIndex(
        (a) =>
          a.titulo_en === animeNovo.titulo_en || a.titulo === animeNovo.titulo,
      );

      if (index !== -1) {
        // Se já existe, atualiza os dados preservando informações antigas
        jsonExistente.schedule[dia][index] = {
          ...jsonExistente.schedule[dia][index],
          ...animeNovo,
        };
      } else {
        // Se é um anime novo no dia, adiciona na lista
        jsonExistente.schedule[dia].push(animeNovo);
      }
    }
  }

  const resultadoFinal = {
    updatedAt: new Date().toISOString(),
    schedule: jsonExistente.schedule,
  };

  if (!fs.existsSync(path.dirname(JSON_FILE)))
    fs.mkdirSync(path.dirname(JSON_FILE), { recursive: true });
  fs.writeFileSync(JSON_FILE, JSON.stringify(resultadoFinal, null, 2), "utf8");

  console.log(`\nSucesso! Os dados foram salvos e imagens atualizadas.`);
}

// ==========================================
// 2. INTEGRAÇÃO GIT / VERCEL (Similar ao sync-animes)
// ==========================================
async function main() {
  await runScraping();

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
    execSync("git push");
    console.log("🚀 Dados de scraping sincronizados e commitados no GitHub!");
  } catch (error) {
    console.error("Erro ao fazer commit/push do scraping:", error.message);
  }
}

main().catch(console.error);
