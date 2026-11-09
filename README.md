# Escritório Hub

Central de controle do escritório, rodando como container no servidor de casa (CasaOS).

- **LEDs (WLED):** liga/desliga, brilho, as 3 cores, efeito, paleta e os ajustes de cada efeito (velocidade, intensidade e os outros que o efeito tiver), em cada ESP32 com WLED ou em todos ao mesmo tempo.
- **Moldura inteira ou 4 lados:** um botão no Controle junta os 4 lados da moldura num segmento só, para efeitos como o Rainbow darem a volta na tela toda, ou separa de novo (cada lado roda o efeito).
- **Prévia ao vivo:** a moldura do monitor (ou a fita) é desenhada na página com as cores reais dos LEDs, quadro a quadro, e a cor de destaque da página acompanha os LEDs.
- **Biblioteca:** todos os efeitos e paletas do WLED, com a prévia das cores de cada paleta, busca, e favoritos fixos no topo (o restante vem depois, em ordem alfabética).
- **PC:** detecta se o PC gamer está ligado (abre uma conexão TCP numa porta do Windows, por padrão a 445).
- **Caixa de som:** liga o relé (usermod *Multi Relay* do WLED) quando o PC liga e desliga depois de um tempo sem o PC. Também tem modo manual.
- **OpenRGB:** conecta no servidor SDK do OpenRGB do PC para listar os dispositivos (RAM, placa-mãe, periféricos), pintar cores e carregar perfis.

A interface fica em `http://IP-DO-SERVIDOR:8090` e funciona no computador e no celular.

## Instalar no CasaOS

1. A cada push na `main`, o GitHub Actions roda os testes e publica a imagem `ghcr.io/diegoukan/escritorio-hub` com a tag da versão do `package.json` (ex.: `0.2.0`) e com `latest`.
2. Na primeira vez, deixe o pacote público para o CasaOS conseguir baixar sem login:
   GitHub → seu perfil → **Packages** → `escritorio-hub` → **Package settings** → **Change visibility** → Public.
   (O código continua privado; só a imagem fica pública.)
3. No CasaOS: **App Store** → **+** → **Install a customized app** → **Import** → cole o conteúdo de [`docker-compose.yml`](docker-compose.yml) → Install.

### Atualizar (sem terminal)

O botão de atualizar do CasaOS não serve para este app: ele não procura versão nova de imagens com a tag `latest`, nem de apps instalados fora da loja. Por isso cada versão ganha a própria tag, e atualizar é trocar essa tag:

1. No painel do CasaOS, abra o menu do app (⋮) → **Settings**.
2. No campo da tag da imagem, troque pela versão nova (ex.: `0.2.0` → `0.3.0`). Se ainda estiver `latest`, troque pela versão atual.
3. Clique em **Save**. O CasaOS baixa a imagem nova e recria o container.

A versão que está rodando aparece em **Ajustes** → **Geral**. As configurações e os favoritos ficam em `/DATA/AppData/escritorio-hub/config.json` no servidor e não se perdem ao atualizar.

## Configuração

Tudo é feito pela aba **Ajustes** da página:

| Campo | O que é |
| --- | --- |
| Dispositivos WLED | ID, nome e endereço de cada ESP32 com WLED. Prefira o **IP** (reserve IP fixo no roteador), porque nomes `.local` nem sempre resolvem dentro do container. |
| Formato | **Moldura de monitor** (quantos LEDs na base, direita, topo e esquerda, começando no canto inferior esquerdo) ou **Fita reta**. Só muda o desenho da prévia. |
| PC | IP fixo do PC gamer e a porta TCP usada para saber se ele está ligado. |
| Caixa de som | Qual WLED tem o relé, o número do relé e quanto tempo esperar antes de desligar. |
| OpenRGB | IP do PC e porta do SDK Server (6742). No OpenRGB, o servidor precisa escutar em `0.0.0.0` (não em `127.0.0.1`) na porta 6742, e o firewall do Windows precisa liberar essa porta para a rede local (`192.168.1.0/24`). |

Os favoritos são marcados na estrela de cada efeito ou paleta e ficam salvos no servidor, valendo para qualquer aparelho.

## API

| Método | Rota | Corpo |
| --- | --- | --- |
| GET | `/api/status` | — |
| GET/PUT | `/api/config` | configuração (parcial no PUT) |
| POST | `/api/all` | `{ on, bri, color: [r,g,b], slot, fx, pal, sx, ix, c1, c2, c3, ps }` para todos os WLED (+ cor no OpenRGB quando `slot` é 0) |
| POST | `/api/wled/:id` | mesmo corpo, para um WLED |
| GET | `/api/wled/:id/lists` | efeitos (com os ajustes e cores que cada um usa) e paletas (com as cores); `?refresh=1` lê de novo do WLED |
| POST | `/api/wled/:id/frame` | `{ mode: "full" \| "sides" }`: junta os 4 lados da moldura num segmento só (o efeito dá a volta na tela) ou separa de novo. A escolha fica salva e o hub reaplica quando o WLED reinicia |
| GET | `/api/wled/:id/live` | prévia ao vivo em Server-Sent Events: cada mensagem é a cor de cada LED em hex (`rrggbb` por LED) |
| POST | `/api/favorites` | `{ kind: "effects" \| "palettes", name, fav: true \| false }` |
| POST | `/api/speaker` | `{ mode: "auto" \| "on" \| "off" }` |
| POST | `/api/openrgb/color` | `{ color: [r,g,b], device?: id }` |
| POST | `/api/openrgb/profile` | `{ name }` |

- `slot` escolhe qual das 3 cores do WLED muda (0 = principal, 1 = fundo, 2 = extra).
- Ao trocar de efeito (`fx`), o WLED aplica os valores padrão daquele efeito, como na interface dele.
- `?quick=1` nas rotas de POST responde sem esperar o estado novo do WLED (usado pelos sliders).

Isso permite chamar o hub pelo Home Assistant, N8N ou Hermes.

## Desenvolvimento

```bash
npm install
npm test
DATA_DIR=./data npm start   # http://localhost:8090
```

Para testar sem ESP32, `node test/fake-wled.js 9911` sobe um WLED falso (98 LEDs, com efeitos, paletas e prévia ao vivo). Depois é só cadastrar `127.0.0.1:9911` em **Ajustes**.
