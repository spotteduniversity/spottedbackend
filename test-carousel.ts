/**
 * Teste isolado: fluxo completo de carrossel (2 slides)
 * Usa token de usuário long-lived (o que o código que funciona usa).
 */
import "dotenv/config";

const USER_TOKEN = "EAANZC1zGjkosBSlAxvFa93zX5lNNkrlYnO0Sq8aYMAgK3WY5OcFU9sBXs4uTkt3E8LicOAhg9jeDRH1J9ZBZBAyMhgQexxSVMZAPyYFEmJ6nxBPsCi6S1kGohozJHB5PQqzCIC7OsaA8SKR0REUDTNbY3ucAw7dQ1g8LkHQR2wGfZAobVM6RAW8BnJ98sm5L0";
const IG_USER_ID = "17841426326909182";
const GRAPH_API_URL = "https://graph.facebook.com/v22.0";

async function waitForMediaReady(mediaId: string): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const url = `${GRAPH_API_URL}/${mediaId}?fields=status_code,status&access_token=${encodeURIComponent(USER_TOKEN)}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.error) {
      throw new Error(`Meta (status): ${data.error.message} (code ${data.error.code})`);
    }
    
    const statusCode = data.status_code;
    const detail = typeof data.status === "string" ? data.status : "";
    console.log(`  ⏳ [${attempt}] ${statusCode}${detail ? ` | ${detail}` : ""}`);
    
    if (statusCode === "FINISHED") {
      console.log("  ✅ Pronto");
      return;
    }
    if (statusCode === "ERROR") {
      throw new Error(`Falhou: ${detail || "sem detalhe"}`);
    }
    if (statusCode === "EXPIRED") {
      throw new Error("Expirou");
    }
    
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Timeout");
}

async function testCarousel() {
  console.log("=== Teste: Carrossel 2 slides ===");
  
  const cardUrl = "https://lizqgchbhvovuucnrdiy.supabase.co/storage/v1/object/public/spotted-posts/cards/spotted_2715.jpg";
  const baseUrl = "https://lizqgchbhvovuucnrdiy.supabase.co/storage/v1/object/public/spotted-assets/c168854f-14e2-43d8-82cb-f9759d7e7992/base.jpg";
  const caption = "[TESTE] Carrossel com page token\n\n#spotted #lavras";
  
  console.log("Card:", cardUrl);
  console.log("Base:", baseUrl);
  
  // 1. Criar item 1 (card)
  console.log("\n1. Criando item do card...");
  let res = await fetch(`${GRAPH_API_URL}/${IG_USER_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: cardUrl,
      is_carousel_item: true,
      access_token: USER_TOKEN,
    }),
  });
  let data = await res.json();
  console.log("   ", JSON.stringify(data, null, 2));
  if (data.error) throw new Error(data.error.message);
  const cardItemId = data.id;
  await waitForMediaReady(cardItemId);
  
  // 2. Intervalo
  console.log("\n2. Intervalo 1.5s...");
  await new Promise(r => setTimeout(r, 1500));
  
  // 3. Criar item 2 (base)
  console.log("\n3. Criando item da base...");
  res = await fetch(`${GRAPH_API_URL}/${IG_USER_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: baseUrl,
      is_carousel_item: true,
      access_token: USER_TOKEN,
    }),
  });
  data = await res.json();
  console.log("   ", JSON.stringify(data, null, 2));
  if (data.error) throw new Error(data.error.message);
  const baseItemId = data.id;
  await waitForMediaReady(baseItemId);
  
  // 4. Criar container do carrossel (JSON com array, como no código que funciona)
  console.log("\n4. Criando container do carrossel (JSON + array)...");
  res = await fetch(`${GRAPH_API_URL}/${IG_USER_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: "CAROUSEL",
      children: [cardItemId, baseItemId],
      caption,
      access_token: USER_TOKEN,
    }),
  });
  data = await res.json();
  console.log("   ", JSON.stringify(data, null, 2));
  if (data.error) throw new Error(data.error.message);
  const carouselId = data.id;
  if (carouselId === "0") throw new Error("Container id 0");
  console.log("   Container:", carouselId);
  await waitForMediaReady(carouselId);
  
  // 5. Publicar
  console.log("\n5. Publicando...");
  res = await fetch(`${GRAPH_API_URL}/${IG_USER_ID}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creation_id: carouselId,
      access_token: USER_TOKEN,
    }),
  });
  data = await res.json();
  console.log("   ", JSON.stringify(data, null, 2));
  if (data.error) throw new Error(data.error.message);
  
  console.log("\n🎉 SUCESSO! Media ID:", data.id);
}

testCarousel().catch((e) => {
  console.error("\n❌ ERRO:", e.message);
  process.exit(1);
});