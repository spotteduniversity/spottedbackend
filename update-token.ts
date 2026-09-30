/**
 * Atualiza o token da conta Lavras no banco com o Page Token novo
 */
import "dotenv/config";
import { supabase } from "./src/config/supabase";
import { encrypt } from "./src/services/cryptoService";

const ACCOUNT_ID = "c168854f-14e2-43d8-82cb-f9759d7e7992";
const PAGE_TOKEN = "EAANZC1zGjkosBSvNZAQUs77XixLWJeAc4SxuxZBf1aLZCOIV67HgMleGztN35RFFOjg2OVmOk8G5EzQi6JvuXVQZAZBlYcuT7h4WOQOUcPOaJtzH3UMoBYUDuA0NQMFIg5ZAAGTOgZBjpSVuGZA9NhGOGpWnANbvTPsjeixgg4qD1zkHK6fPzCAmLqXLsUXDkrlgK7GcvTARZA";
const IG_USER_ID = "17841426326909182";

async function main() {
  if (!supabase) throw new Error("Supabase nao configurado.");

  const encrypted = encrypt(PAGE_TOKEN);
  
  const { error } = await supabase
    .from("instagram_accounts")
    .update({
      access_token_encrypted: encrypted,
      ig_user_id: IG_USER_ID,
      connection_status: "ok",
      username: "lavras_spotted",
    })
    .eq("id", ACCOUNT_ID);

  if (error) throw error;
  
  console.log("Token atualizado com sucesso!");
  console.log("Conta:", ACCOUNT_ID);
  console.log("Token: Page Token (never expires)");
}

main().catch((err) => {
  console.error("Falhou:", err.message);
  process.exit(1);
});