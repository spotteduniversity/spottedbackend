import axios from "axios";
import * as cheerio from "cheerio";

const CARD_URL = "https://sistemas.prefeituralimeira.unicamp.br/RU/view/site/cardapio.php";

export interface MenuItem {
  pratoPrincipal: string;
  guarnicao: string;
  salada: string;
  sobremesa: string;
  refresco: string;
}

export interface ScrapedMenu {
  date: string;
  dayOfWeek: string;
  almoco: {
    padrao: MenuItem;
    vegano: MenuItem;
  };
  jantar: {
    padrao: MenuItem;
    vegano: MenuItem;
  };
  cafeDaManha: string;
}

function parseTable($: cheerio.CheerioAPI, table: any): MenuItem {
  const item: MenuItem = {
    pratoPrincipal: "",
    guarnicao: "",
    salada: "",
    sobremesa: "",
    refresco: "",
  };

  $(table).find("tr").each((_, row) => {
    const td = $(row).find("td").first();
    const strongText = td.find("strong").text().trim().toUpperCase();
    const fullHtml = td.html() || "";
    const fullText = td.text().trim();

    let value = "";
    const brIndex = fullHtml.indexOf("<br");
    if (brIndex !== -1) {
      const afterBr = fullHtml.substring(brIndex);
      const tempDiv = cheerio.load(`<div>${afterBr}</div>`);
      value = tempDiv("div").text().trim();
    } else {
      value = fullText.replace(strongText, "").replace(":", "").trim();
    }

    if (strongText.includes("PRATO PRINCIPAL")) {
      item.pratoPrincipal = value;
    } else if (strongText.includes("GUARNI")) {
      item.guarnicao = value;
    } else if (strongText.includes("SALADA")) {
      item.salada = value;
    } else if (strongText.includes("SOBREMESA")) {
      item.sobremesa = value;
    } else if (strongText.includes("REFRESCO")) { 
      item.refresco = value;
    }
    
  });

  return item;
}

function getTablesFromMeal($: cheerio.CheerioAPI, mealId: string): { padrao: MenuItem; vegano: MenuItem } {
  const mealDiv = $(`#${mealId}`);
  const col6Tables = mealDiv.find(".col-6 table");
  
  const padrao = parseTable($, $(col6Tables.get(0)));
  const vegano = parseTable($, $(col6Tables.get(1)));

  return { padrao, vegano };
}

export async function scrapeBandeco(): Promise<ScrapedMenu> {
  const response = await axios.get(CARD_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    timeout: 10000,
  });

  const $ = cheerio.load(response.data);

  const dateText = $("#dia .h3").text().trim();
  const dateMatch = dateText.match(/(\d{2}\/\d{2}\/\d{4})/);
  const dayMatch = dateText.match(/\((.*?)\)/);
  
  const date = dateMatch ? dateMatch[1] : new Date().toLocaleDateString("pt-BR");
  const dayOfWeek = dayMatch ? dayMatch[1] : "";

  const almoco = getTablesFromMeal($, "normal");
  const jantar = getTablesFromMeal($, "vegetariano");

  const cafeDaManha = $("#dia .row:last-child table").text().trim();

  return {
    date,
    dayOfWeek,
    almoco,
    jantar,
    cafeDaManha,
  };
}

export async function scrapeAlmoco(): Promise<{ date: string; dayOfWeek: string; padrao: MenuItem; vegano: MenuItem }> {
  const full = await scrapeBandeco();
  return {
    date: full.date,
    dayOfWeek: full.dayOfWeek,
    padrao: full.almoco.padrao,
    vegano: full.almoco.vegano,
  };
}

export async function scrapeJantar(): Promise<{ date: string; dayOfWeek: string; padrao: MenuItem; vegano: MenuItem }> {
  const full = await scrapeBandeco();
  return {
    date: full.date,
    dayOfWeek: full.dayOfWeek,
    padrao: full.jantar.padrao,
    vegano: full.jantar.vegano,
  };
}