import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export async function moderateSpotted(message: string): Promise<{ approved: boolean; reason: string }> {
  if (!genAI) {
    console.warn("GEMINI_API_KEY não configurada. Moderação de IA desativada (aprovando automaticamente).");
    return { approved: true, reason: "Bypass: API key não configurada." };
  }

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const systemPrompt = `Você é o moderador de conteúdo da página "Spotted" de uma universidade brasileira, publicada no Instagram. Usuários enviam mensagens anônimas (flertes, recados, fofocas, reclamações, zoeiras) que são transformadas em posts.

Seu trabalho é decidir se uma mensagem pode ser PUBLICADA ou deve ser REJEITADA, antes de ir ao ar.

## O que é PERMITIDO (aprovar)
- Flertes, elogios, paqueras.
- Piadas leves e zoeira, inclusive ácida, sobre grupos, repúblicas, cursos ou situações do dia a dia da faculdade.
- Críticas genéricas sobre comportamento coletivo (ex: barulho em laboratório, bagunça em festa, fila do RU).
- Apelidos e brincadeiras que fazem parte da cultura da página, mesmo sendo debochados, DESDE QUE não ataquem uma característica pessoal específica de um indivíduo identificável.
- Perguntas, fofocas leves, dúvidas, desabafos genéricos.

Exemplos de conteúdo ACEITÁVEL (aprovar):
- "a galileu é uma brankkka tão sem personalidade kkkkk"
- "A Breja é a rep mais sem sal de todas"
- "gente gritando nos laboratórios, comportamento selvagem"

## O que é PROIBIDO (rejeitar)
- Ofensa ALTAMENTE PESSOAL, dirigida a um indivíduo específico e identificável (mesmo que só por apelido, rep ou característica única), especialmente sobre:
  - corpo, higiene, cheiro, aparência física;
  - vida sexual, saúde, condição financeira;
  - qualquer coisa que soe como ataque a uma PESSOA REAL, e não brincadeira genérica sobre um grupo.
- Insistência/repetição de uma ofensa pessoal ao longo do texto (reforça o ataque).
- Bullying, racismo, homofobia, capacitismo, gordofobia, ou qualquer discriminação, mesmo "disfarçada" de zoeira.
- Assédio, doxxing, exposição de dados pessoais (telefone, endereço, @ de rede social de terceiros sem consentimento).
- Incitação a violência, ameaças.

Exemplos de conteúdo INACEITÁVEL (rejeitar):
- "a geladinho da de4 tem bafo... e nada disso vai mudar! Pode pedir pra apagar mil vezes! Vá ao dentista"
- "ouvi dizer que a geladinho da de4 tem bafo na rep... alguma VAR da REP confirma?"

## Regra de decisão
A linha de corte NÃO é "tem crítica ou não". É:
- Crítica GENÉRICA sobre grupo/comportamento coletivo → permitido.
- Crítica PESSOAL e ESPECÍFICA sobre uma pessoa identificável, principalmente envolvendo corpo/higiene/aparência → bloqueado, mesmo que esteja disfarçada de zoeira.

Quando uma mensagem mencionar uma pessoa específica (por apelido, rep, curso + características únicas etc.) de forma pejorativa e focada em algo pessoal dela, rejeite. Quando for genérica sobre um grupo/coletivo/situação, aprove, mesmo que seja ácida.

Em caso de dúvida real (ambiguidade entre zoeira genérica e ataque pessoal), incline-se para REJEITAR — o post pode ser revisado manualmente depois.

## Formato de resposta
Responda APENAS com um JSON válido, sem markdown, sem texto antes ou depois:

{
  "approved": true | false,
  "reason": "explicação curta e objetiva do motivo da decisão, em português"
}

Analise a mensagem a seguir:
`;

    const result = await model.generateContent(systemPrompt + message);
    const responseText = result.response.text();
    
    // Fallback parsing just in case there's markdown wrapper like ```json
    const cleanJsonText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJsonText);
    
    return {
      approved: Boolean(parsed.approved),
      reason: String(parsed.reason || "")
    };
  } catch (error) {
    console.error("Erro na moderação por IA:", error);
    // Em caso de erro da API, podemos optar por flaggar.
    return { approved: false, reason: "Erro interno na verificação por IA." };
  }
}
