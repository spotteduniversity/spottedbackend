/**
 * Teste isolado: publica uma única imagem (sem carrossel)
 * Usa token de Página que não expira.
 */
import "dotenv/config";
import { storageService } from "./src/services/storageService";

const PAGE_TOKEN = "EAANZC1zGjkosBSvNZAQUs77XixLWJeAc4SxuxZBf1aLZCOIV67HgMleGztN35RFFOjg2OVmOk8G5EzQi6JvuXVQZAZBlYcuT7h4WOQOUcPOaJtzH3UMoBYUDuA0NQMFIg5ZAAGTOgZBjpSVuGZA9NhGOGpWnANbvTPsjeixgg4qD1zkHK6fPzCAmLqXLsUXDkrlgK7GcvTARZA";
const IG_USER_ID = "17841426326909182";
const GRAPH_API_URL = "https://graph.facebook.com/v22.0";

async function testSingleImage() {
  console.log("=== Teste: postagem de imagem única ===");
  
  // Usa a imagem base que já existe no bucket
  const imageUrl = "https://lizqgchbhvovuucnrdiy.supabase.co/storage/v1/object/public/spotted-assets/c168854f-14e2-43d8-82cb-f9759d7e7992/base.jpg";
  console.log("Imagem:", imageUrl);
  
  // Step 1: Criar container
  const createUrl = `${GRAPH_API_URL}/${IG_USER_ID}/media`;
  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: imageUrl,
      caption: "Teste imagem única - lavras_spotted",
      access_token: PAGE_TOKEN,
    }),
  });
  const createData = await createRes.json();
  console.log("Create:", JSON.stringify(createData, null, 2));
  
  if (createData.error) {
    console.error("Erro ao criar container:", createData.error);
    return;
  }
  
  const creationId = createData.id;
  console.log("Container criado:", creationId);
  
  // Aguardar processamento
  console.log("Aguardando processamento...");
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusUrl = `${GRAPH_API_URL}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(PAGE_TOKEN)}`;
    const statusRes = await fetch(statusUrl);
    const statusData = await statusRes.json();
    console.log(`  [${i+1}] status: ${statusData.status_code}${statusData.status ? ` | ${statusData.status}` : ""}`);
    
    if (statusData.status_code === "FINISHED") {
      console.log("Container pronto!");
      break;
    }
    if (statusData.status_code === "ERROR") {
      console.error("Erro no processamento:", statusData.status);
      return;
    }
  }
  
  // Step 2: Publicar
  const publishUrl = `${GRAPH_API_URL}/${IG_USER_ID}/media_publish`;
  const publishRes = await fetch(publishUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creation_id: creationId,
      access_token: PAGE_TOKEN,
    }),
  });
  const publishData = await publishRes.json();
  console.log("Publish:", JSON.stringify(publishData, null, 2));
}

testSingleImage().catch(console.error);