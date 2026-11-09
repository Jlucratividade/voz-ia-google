# Voz IA Google

Aplicativo web que converte texto em áudio usando **somente APIs oficiais do Google**, com dois provedores à escolha na própria tela:

| | Google Cloud Text-to-Speech | Gemini (chave do AI Studio) |
|---|---|---|
| Credencial | Service Account (JSON) | Chave de API gratuita, sem cartão |
| Variável na Vercel | `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` | `GEMINI_API_KEY` |
| Faturamento | Exigido (cota gratuita mensal) | Não exigido na faixa gratuita |
| Formato | MP3 | WAV |
| Controles | Velocidade, tom, volume | Ritmo e instrução de estilo em texto |
| Vozes | Lista real da API (`voices.list`) | 30 vozes da documentação oficial |

Você pode configurar **só um** dos dois: o app mostra apenas os provedores que estão configurados.
Interface em HTML/CSS/JS puro, servidor em funções Node.js da Vercel, credenciais protegidas em variável de ambiente.

> Dados de preços, cotas e modelos conferidos nas páginas oficiais do Google em **08/11/2026**. Preços mudam: antes de usar em produção, confira a [página oficial de preços](https://cloud.google.com/text-to-speech/pricing).

---

## 1. Arquivos do projeto

```
voz-ia-google/
├── index.html        Interface completa (tela, estilos e lógica do navegador)
├── api/
│   ├── tts.js        Gera o áudio (POST /api/tts), nos dois provedores
│   └── voices.js     Lista as vozes e os provedores configurados (GET /api/voices)
├── lib/
│   ├── google.js     Google Cloud: login, mensagens de erro, divisão de textos longos, proteções
│   └── gemini.js     Gemini: chamada à API, vozes, modelos, conversão de áudio e erros
├── package.json      Dependência: google-auth-library (biblioteca oficial do Google para login)
├── vercel.json       Configurações da Vercel (tempo máximo das funções e cabeçalhos de segurança)
├── .gitignore        Impede que arquivos de credenciais sejam enviados ao GitHub
└── README.md         Este guia
```

**Por que existem arquivos além dos pedidos?**
- `lib/google.js`: evita repetir o mesmo código nas duas funções. Fica fora da pasta `api/` porque tudo dentro de `api/` vira um endereço público na Vercel.
- `vercel.json`: define o tempo máximo de uma geração (60 s) e cabeçalhos de segurança do navegador.
- `.gitignore`: rede de segurança contra enviar a chave JSON ao GitHub por engano.

---

## 2. Comparativo de modelos e custos

Fonte: [cloud.google.com/text-to-speech/pricing](https://cloud.google.com/text-to-speech/pricing) (cobrança por **caractere enviado**, incluindo espaços e quebras de linha).

| Modelo | Cota gratuita mensal | Preço após a cota | Observação oficial |
|---|---|---|---|
| **Standard** | 4 milhões de caracteres | US$ 4 por 1 milhão | Listado como "legacy"; foco em custo |
| **WaveNet** | 4 milhões de caracteres | US$ 4 por 1 milhão | Listado como "legacy"; mesmo SKU de preço do Standard |
| **Neural2** | 1 milhão de caracteres | US$ 16 por 1 milhão | Uso geral, aceita SSML |
| **Chirp 3 HD** | 1 milhão de caracteres | US$ 30 por 1 milhão | Geração mais recente, "latest TTS models" |

Respostas às perguntas do projeto:

- **Maior franquia gratuita:** Standard e WaveNet (4 milhões de caracteres/mês).
- **Menor custo por caractere após a franquia:** Standard e WaveNet empatam (US$ 4 por milhão).
- **Diferenças de cobrança:** sim, são quatro faixas de preço diferentes (tabela acima). A tabela oficial mostra o mesmo identificador de preço (SKU) para Standard e WaveNet, o que sugere uma **cota gratuita compartilhada** entre os dois. Confirme isso no relatório de faturamento do seu projeto.
- **Português do Brasil (pt-BR):** o Chirp 3 HD tem pt-BR confirmado na lista oficial de idiomas. Para Standard, WaveNet e Neural2, as notas de versão do Google mencionam vozes pt-BR de Standard e WaveNet, mas **eu não consegui ler as linhas de pt-BR da tabela completa de vozes** (a página é enorme). Por isso o app não presume nada: ele consulta a API ao abrir e mostra, em cada cartão de modelo, **quantas vozes existem de verdade** no idioma escolhido (modelo sem vozes fica desativado).
- **Narrações longas:** todos os modelos aceitam no máximo **5.000 bytes por requisição**. O app divide textos longos automaticamente (em parágrafos, depois frases) e junta os MP3. O Chirp 3 HD tem cota de 200 requisições por minuto por projeto; os demais 1.000.
- **Padrão do app: WaveNet.** Custa o mesmo que o Standard, tem a mesma cota gratuita de 4 milhões e soa mais natural. O Chirp 3 HD custa 7,5 vezes mais e tem um quarto da cota gratuita; vale para quando o realismo for prioridade.

Exemplo de custo de referência, **fora** da cota gratuita, para um texto de 12.000 caracteres (o máximo do app): WaveNet ≈ US$ 0,05 · Neural2 ≈ US$ 0,19 · Chirp 3 HD ≈ US$ 0,36.

### O que cada modelo aceita neste app

| Controle | Standard / WaveNet / Neural2 | Chirp 3 HD |
|---|---|---|
| Velocidade | 0,25× a 4× | 0,25× a 2× (recurso em Preview segundo a documentação) |
| Tom (pitch) | −20 a +20 semitons | não oferecido |
| Volume | −96 a +16 dB (a barra do app mostra −20 a +16) | não oferecido |

Observação: a documentação do Google tem uma nota antiga dizendo que o Chirp 3 HD não aceita velocidade e tom, e uma página mais recente descrevendo controle de velocidade. O app segue a versão mais recente para velocidade e a nota para tom e volume. Se o Google recusar algo, a mensagem exata dele aparece na tela.

---

## 2b. Provedor Gemini (gratuito, com a chave do AI Studio)

O Gemini API tem uma faixa gratuita e **não usa Service Account nem faturamento**. Fontes: [preços](https://ai.google.dev/gemini-api/docs/pricing), [geração de voz](https://ai.google.dev/gemini-api/docs/speech-generation) e [limites](https://ai.google.dev/gemini-api/docs/rate-limits).

**Modelos oferecidos e o que foi confirmado (em 09/11/2026):**

| Modelo | Faixa gratuita | Fonte da informação |
|---|---|---|
| `gemini-3.1-flash-tts-preview` | Sim | Página oficial de preços |
| `gemini-2.5-flash-preview-tts` | Sim | Página oficial de preços |
| `gemini-3.8-flash-tts` e `gemini-3.8-flash-lite-tts` | Sim, segundo artigos de terceiros | **Não consegui confirmar na página oficial**: os modelos aparecem na documentação de voz, mas não na parte da tabela de preços que consegui ler. Se der erro de cota, use um dos dois modelos acima. |

**O que você precisa saber antes de usar:**
- **Limites:** o Google não publica os números por minuto e por dia dos modelos de voz. Eles aparecem para o seu projeto em <https://aistudio.google.com/rate-limit> e podem mudar. Cada parte de texto (até 900 caracteres) consome **uma requisição**; um texto de 10.000 caracteres usa cerca de 12.
- **Privacidade:** na faixa gratuita, o Google pode usar o que você envia para melhorar seus produtos (a regra costuma ser diferente em EEE, Suíça e Reino Unido). Não envie textos confidenciais.
- **Preços futuros:** um artigo de terceiros afirma que as tarifas pagas dos modelos 3.8 dobram em 1º de janeiro de 2027; não verifiquei isso no site oficial. Na faixa gratuita não há cobrança.
- **Formato WAV, não MP3:** o Gemini devolve áudio sem compressão (cerca de 48 KB por segundo, ~2,9 MB por minuto). O app junta as partes em um único WAV no navegador, com 0,2 s de pausa entre elas. Se precisar de MP3, converta depois (por exemplo, no Audacity).
- **Textos em partes:** a Vercel limita a resposta de cada chamada a 4,5 MB (cerca de 90 s de áudio), por isso o navegador pede o áudio em partes de até 900 caracteres, uma de cada vez, e as une. O limite do app é **10.000 caracteres por geração**. Se uma parte falhar, o arquivo não é montado e você precisa gerar de novo.
- **Voz e estilo:** o Gemini não tem controles de velocidade, tom e volume. Você escolhe o **ritmo** (lento, normal, rápido) e pode escrever uma instrução de estilo (ex.: "tom calmo e acolhedor"). O app envia um prefixo em inglês pedindo para ler só a transcrição; mesmo assim, o modelo às vezes devolve texto em vez de voz, e o servidor tenta de novo até 3 vezes.
- **Gênero das vozes:** a documentação não informa, então o app não mostra gênero nem os filtros para o Gemini. Os nomes das 30 vozes vêm da documentação oficial.

**Como criar a chave (3 minutos, sem cartão):**
1. Entre em <https://aistudio.google.com/apikey> com sua conta Google.
2. Clique em **Criar chave de API** (Create API key) e escolha ou crie um projeto.
3. Copie a chave (começa com `AIza`). Trate-a como senha: não envie ao GitHub nem cole em conversas.
4. Na Vercel, cadastre `GEMINI_API_KEY` com essa chave (passo C4 abaixo) e faça o deploy.

> Se você configurar **apenas** o Gemini, pode pular toda a Parte A (Google Cloud) e o faturamento. Se não quiser usar o Gemini, é só não cadastrar `GEMINI_API_KEY`.

---

## 3. Como o app protege você

- As credenciais (Service Account e chave do Gemini) **nunca vão ao navegador**: só existem em variáveis de ambiente da Vercel e são lidas apenas pelas funções em `api/`. A chave do Gemini viaja só no cabeçalho `x-goog-api-key`, nunca na URL.
- **Senha opcional (recomendada):** como o endereço do app é público, qualquer pessoa que o encontrar gastaria a sua cota. Defina a variável `APP_ACCESS_PASSWORD` e o app passa a pedir uma senha.
- Limite de **10 gerações por minuto por IP** no Google Cloud e **30 requisições por minuto por IP** no Gemini (que envia uma por parte) (por instância) e bloqueio de chamadas vindas de outros sites. Esse limite reduz abusos, mas não é absoluto na Vercel; a senha e o alerta de orçamento são as proteções fortes.
- O texto digitado **não é gravado** em lugar nenhum nem aparece nos logs.
- **Limite de 12.000 caracteres por geração.** Motivo: a Vercel limita a resposta de uma função a 4,5 MB, e esse tamanho de texto gera um MP3 próximo disso.

**Importante sobre a "cota gratuita":** com o faturamento ativo, passar da cota gratuita **não bloqueia** o uso, apenas começa a cobrar. O app não rastreia seu consumo mensal. Crie um **alerta de orçamento** (passo 6 abaixo).

---

## 4. Passo a passo de instalação (para iniciantes)

Tempo estimado: 30 a 45 minutos. Os nomes de menus do Google Cloud podem mudar um pouco com o tempo; se algo não estiver igual, use a barra de busca do console.

### Parte A: Google Cloud

**A1. Conta Google Cloud**
1. Acesse <https://console.cloud.google.com/> e entre com sua conta Google.
2. Aceite os termos. A página oficial informa que novos clientes recebem US$ 300 em créditos (confira as condições na tela de cadastro).

**A2. Criar um projeto**
1. No topo da tela, clique no seletor de projetos e depois em **Novo projeto**.
2. Nome sugerido: `voz-ia-google`. Clique em **Criar** e selecione o projeto criado.

**A3. Ativar a API Cloud Text-to-Speech**
1. Abra <https://console.cloud.google.com/apis/library/texttospeech.googleapis.com>.
2. Confirme que o projeto certo está selecionado no topo e clique em **Ativar**.

**A4. Faturamento**
A página oficial de preços diz que é **preciso ativar o faturamento** para usar o Text-to-Speech, e que a cobrança só ocorre se você passar da cota gratuita do mês.
1. Abra <https://console.cloud.google.com/billing>.
2. Vincule uma conta de faturamento ao projeto (será pedido um cartão).

**A5. Criar a Service Account (conta de serviço)**
1. Menu **IAM e administrador > Contas de serviço** (<https://console.cloud.google.com/iam-admin/serviceaccounts>).
2. **Criar conta de serviço**. Nome: `voz-ia-google-tts`. Clique em **Criar e continuar**.
3. **Permissões:** deixe o papel em branco e conclua. Não dê papéis amplos como "Proprietário" ou "Editor".
   - Se, no teste final, aparecer o erro de permissão citando `serviceusage.services.use`, volte em **IAM e administrador > IAM**, adicione a Service Account e conceda só o papel **Consumidor do Service Usage** (`roles/serviceusage.serviceUsageConsumer`). Não encontrei na documentação do Text-to-Speech um papel específico exigido; por isso começamos sem nenhum, o princípio do menor privilégio.

**A6. Gerar a chave JSON**
1. Clique na Service Account criada > aba **Chaves** > **Adicionar chave > Criar nova chave > JSON** > **Criar**.
2. Um arquivo `.json` é baixado. **Ele é como uma senha:** não envie ao GitHub, não mande por e-mail nem cole em conversas.
3. Se o botão de criar chave estiver bloqueado, sua organização tem uma política de segurança que impede chaves; é preciso pedir liberação ao administrador.

### Parte B: GitHub

1. Crie uma conta em <https://github.com/signup> (se ainda não tiver).
2. Abra <https://github.com/new>. Nome: `voz-ia-google`. Marque **Private** (recomendado). Clique em **Create repository**.
3. Na página do repositório vazio, clique em **uploading an existing file**.
4. **Arraste para a tela a pasta inteira do projeto**: `index.html`, `package.json`, `vercel.json`, `.gitignore`, `README.md` e as pastas `api` e `lib`. Confirme que `api/tts.js`, `api/voices.js` e `lib/google.js` aparecem na lista.
5. **Confira que NÃO há nenhum arquivo `.json` de credenciais** (só `package.json` e `vercel.json` são permitidos).
6. Clique em **Commit changes**.

### Parte C: Vercel

1. Crie uma conta em <https://vercel.com/signup> entrando com o GitHub.
2. Abra <https://vercel.com/new> e importe o repositório `voz-ia-google`.
3. Em **Framework Preset**, deixe **Other**. Não precisa preencher comandos de build.
4. Abra **Environment Variables** e cadastre:

| Nome | Valor | Obrigatória |
|---|---|---|
| `GEMINI_API_KEY` | A chave do AI Studio (seção 2b) | Sim, se quiser usar o Gemini |
| `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` | Todo o conteúdo do arquivo JSON baixado (abra no Bloco de Notas, selecione tudo, copie e cole; do primeiro `{` ao último `}`) | Sim, se quiser usar o Google Cloud |
| `APP_ACCESS_PASSWORD` | Uma senha forte que você inventar | Recomendada |
| `RATE_LIMIT_PER_MINUTE` | Gerações por minuto por IP no Google Cloud (padrão 10) | Não |

É preciso configurar **pelo menos uma** das duas credenciais.

5. Clique em **Deploy** e aguarde. A Vercel mostra o endereço, algo como `voz-ia-google.vercel.app`.
6. **Se você mudar uma variável depois**, é preciso fazer um novo deploy (Deployments > ⋯ > Redeploy) para ela valer.
7. Depois de colar o JSON na Vercel, guarde o arquivo original em local seguro (gerenciador de senhas) ou apague-o do computador.

### Parte D: Testar

1. Abra o endereço do app. Em **Provedor de voz** devem aparecer os dois cartões; o que não estiver configurado fica desativado com um aviso. A lista de voz deve carregar com **Idioma: Português (Brasil)**. No Google Cloud o modelo **WaveNet** vem marcado; no Gemini, o **Gemini 3.8 Flash TTS**.
2. Cole um texto curto e clique em **✨ GERAR ÁUDIO**. O player aparece; teste **Baixar MP3**.
3. Teste também um modelo diferente (Neural2 ou Chirp 3 HD) e veja a quantidade de vozes em cada cartão.
4. Teste o Gemini: escolha o cartão **Gemini**, cole um texto curto e gere. Se o modelo 3.8 acusar limite ou indisponibilidade, escolha o **Gemini 2.5 Flash TTS (Preview)**. Confira se o arquivo baixado é `.wav` e toca.
5. Teste um texto de uns 2.000 caracteres no Gemini: a tela deve mostrar "Gerando a parte 1 de N…" e entregar um único arquivo.
6. Abra `https://SEU-APP.vercel.app/api/voices`: deve aparecer o JSON com os provedores e as vozes.

### Parte E: Conferir se as credenciais estão protegidas

1. No app, clique com o botão direito > **Exibir código-fonte** e use Ctrl+F para buscar `private_key`, `client_email` e `AIza`. **Nada deve ser encontrado.**
2. No GitHub, abra o repositório e confirme que não existe nenhum arquivo de chave.
3. Na Vercel (**Settings > Environment Variables**), confirme que a chave só existe ali.
4. Se uma chave vazar por qualquer motivo: no Google Cloud, apague a chave da Service Account (Contas de serviço > Chaves > Excluir) ou, no AI Studio, apague a chave de API; gere outra e atualize a Vercel.

### Parte F: Alerta de orçamento (altamente recomendado)

1. <https://console.cloud.google.com/billing> > sua conta > **Orçamentos e alertas** > **Criar orçamento**.
2. Defina um valor baixo (por exemplo, US$ 5) e alertas por e-mail. Atenção: o alerta **avisa**, mas não interrompe o gasto sozinho.

---

## 5. Solução de problemas

| Mensagem no app | Causa provável | O que fazer |
|---|---|---|
| "A variável GOOGLE_TTS_SERVICE_ACCOUNT_JSON não está configurada" | Variável ausente ou deploy feito antes de cadastrá-la | Cadastre na Vercel e faça **Redeploy** |
| "não é um JSON válido" | JSON copiado incompleto | Copie o arquivo inteiro, do primeiro `{` ao último `}` |
| "O Google recusou as credenciais" | Chave apagada, revogada ou de outro projeto | Gere nova chave e atualize a variável |
| "Nenhum provedor de voz está configurado" | Nem `GEMINI_API_KEY` nem `GOOGLE_TTS_SERVICE_ACCOUNT_JSON` cadastradas, ou falta o Redeploy | Cadastre ao menos uma e faça **Redeploy** |
| "O Google recusou a chave GEMINI_API_KEY" | Chave inválida, com espaço sobrando, ou apagada | Gere outra em aistudio.google.com/apikey e atualize a variável |
| "O limite gratuito do Gemini API foi atingido" | Limite por minuto ou por dia do seu projeto (o diário reinicia à meia-noite do horário do Pacífico) | Espere, escolha outro modelo Gemini (cada modelo tem limites próprios) ou use o Google Cloud |
| "O Gemini respondeu sem áudio" | O modelo devolveu texto em vez de voz | Tente de novo; se persistir, remova a instrução de estilo ou troque o modelo |
| "O Gemini recusou este trecho" | Conteúdo bloqueado ou pedido ambíguo | Reescreva o trecho |
| "Este modelo ou voz não está disponível para a sua chave" | Modelo ainda não liberado para o seu projeto ou país | Escolha outro modelo da lista |
| "Falha na parte X de N" (Gemini) | Uma das partes falhou (limite, rede) | Veja a mensagem; gere de novo depois de esperar |
| "A API Cloud Text-to-Speech não está ativada" | Passo A3 não feito ou projeto errado | Ative a API no projeto da chave e espere 1 a 2 minutos |
| "não tem uma conta de faturamento ativa" | Passo A4 não feito | Vincule o faturamento ao projeto |
| "não tem permissão" | Chave de outro projeto ou falta de permissão | Veja o passo A5 (papel Consumidor do Service Usage) |
| "limite de requisições (cota)" | Muitas gerações em um minuto | Aguarde cerca de 1 minuto |
| "Muitas requisições em pouco tempo" | Limite do próprio app (por IP) | Aguarde alguns segundos |
| "Esta voz não está disponível" | Voz retirada ou indisponível no Google | Escolha outra voz |
| "O texto passou do limite de 12.000 caracteres" | Texto grande | Divida em partes |
| "Senha de acesso incorreta" | Senha diferente de `APP_ACCESS_PASSWORD` | Digite a senha cadastrada na Vercel |
| Lista de vozes não carrega e aparece erro 404 | Pastas `api/` ou `lib/` não foram enviadas ao GitHub | Confira os arquivos no repositório e refaça o deploy |
| Erro 500 genérico | Falha inesperada | Vercel > seu projeto > aba **Logs**, para ver o detalhe |

---

## 6. Limites e pontos de atenção

- Este pacote foi **testado com APIs simuladas** (servidor em Node e página em Chrome): fluxo dos dois provedores, divisão em partes, montagem do WAV, validações e erros. **Não foi testado contra o Google real** (Cloud TTS nem Gemini), pois não há credenciais nem acesso à rede neste ambiente. O primeiro teste real é o da Parte D.
- **Gemini: formato da requisição.** A documentação do Google descreve a Interactions API de duas formas ligeiramente diferentes para o campo `input`. O servidor tenta primeiro o formato atual e, se o Google responder com erro 400, tenta o alternativo e memoriza o que funcionou. Se ainda assim falhar, a mensagem do Google aparece na tela. Não verifiquei o formato alternativo (`generateContent`) na documentação oficial.
- Os modelos Gemini são em grande parte **Preview**: nomes, limites e gratuidade podem mudar sem aviso.
- A versão da biblioteca `google-auth-library` (`^9.15.1`) não pôde ser verificada contra o registro do npm daqui; a Vercel instala automaticamente ao fazer o deploy. Se o deploy reclamar do pacote, troque por outra versão estável.
- Vozes são carregadas do Google ao vivo e ficam em cache por 1 hora.
- Textos longos são divididos em partes e os MP3 são concatenados. Se uma parte falhar no meio, as anteriores já foram cobradas.
- O app não usa "Long Audio Synthesis", Studio, Polyglot, Journey nem Gemini-TTS; só os quatro modelos pedidos.
- Os filtros **Natural**, **Profissional** e **Alta qualidade** são agrupamentos do app, baseados no modelo da voz (o Google não classifica vozes assim). Gênero vem da API.

---

## 7. Links oficiais

- Chave do Gemini (AI Studio): <https://aistudio.google.com/apikey>
- Limites do seu projeto no AI Studio: <https://aistudio.google.com/rate-limit>
- Preços do Gemini API: <https://ai.google.dev/gemini-api/docs/pricing>
- Geração de voz do Gemini: <https://ai.google.dev/gemini-api/docs/speech-generation>
- Google Cloud Console: <https://console.cloud.google.com/>
- Ativar a API Text-to-Speech: <https://console.cloud.google.com/apis/library/texttospeech.googleapis.com>
- Preços: <https://cloud.google.com/text-to-speech/pricing>
- Cotas e limites: <https://docs.cloud.google.com/text-to-speech/quotas>
- Vozes e idiomas: <https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types>
- Chirp 3 HD: <https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd>
- Referência da API (voices.list): <https://cloud.google.com/text-to-speech/docs/reference/rest/v1/voices/list>
- Faturamento: <https://console.cloud.google.com/billing>
- Contas de serviço: <https://console.cloud.google.com/iam-admin/serviceaccounts>
- GitHub: <https://github.com/>
- Vercel: <https://vercel.com/>
- Limites das funções da Vercel: <https://vercel.com/docs/functions/limitations>
