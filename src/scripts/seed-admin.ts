/**
 * seed-admin.ts — Script CLI para criar o primeiro admin no banco.
 *
 * Uso:
 *   npx ts-node src/scripts/seed-admin.ts <username> <password> [--super]
 *
 * Exemplos:
 *   npx ts-node src/scripts/seed-admin.ts joao senha123        # admin normal
 *   npx ts-node src/scripts/seed-admin.ts joao senha123 --super # super-admin
 *
 * Pré-requisitos:
 *   - .env configurado com SUPABASE_URL e SUPABASE_SERVICE_KEY
 *   - Migração SQL já executada (tabela admins existe)
 *
 * NUNCA expor este script como endpoint HTTP.
 */

import dotenv from "dotenv";
dotenv.config();

import { hashAdminPassword } from "../services/adminAuthService";
import { adminRepository } from "../services/adminRepository";

async function main() {
  const args = process.argv.slice(2);
  const username = args[0];
  const password = args[1];
  const isSuper = args.includes("--super");

  if (!username || !password) {
    console.error("❌ Uso: npx ts-node src/scripts/seed-admin.ts <username> <password> [--super]");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("❌ A senha deve ter pelo menos 8 caracteres.");
    process.exit(1);
  }

  try {
    console.log(`🔐 Criando admin: ${username} (super: ${isSuper})`);
    const password_hash = await hashAdminPassword(password);

    const admin = await adminRepository.create({ username, password_hash, is_super: isSuper });

    console.log("✅ Admin criado com sucesso!");
    console.log(`   ID:       ${admin.id}`);
    console.log(`   Username: ${admin.username}`);
    console.log(`   Super:    ${admin.is_super}`);
    console.log("");
    console.log("💡 Próximo passo: vincule este admin a uma conta do Instagram via painel.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "DUPLICATE_USERNAME") {
      console.error(`❌ Username "${username}" já existe.`);
    } else {
      console.error("❌ Erro ao criar admin:", message);
    }
    process.exit(1);
  }
}

main();
