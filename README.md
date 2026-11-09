# Escritório Hub

Central de controle do escritório, rodando como container no servidor de casa (CasaOS).

- **LEDs (WLED):** liga/desliga, brilho, cor, efeito, paleta e velocidade de cada ESP32 com WLED, ou de todos ao mesmo tempo.
- **PC:** detecta se o PC gamer está ligado (abre uma conexão TCP numa porta do Windows, por padrão a 445).
- **Caixa de som:** liga o relé (usermod *Multi Relay* do WLED) quando o PC liga e desliga depois de um tempo sem o PC. Também tem modo manual.
- **OpenRGB:** conecta no servidor SDK do OpenRGB do PC para listar os dispositivos (RAM, placa-mãe, periféricos), pintar cores e carregar perfis.

A interface fica em `http://IP-DO-SERVIDOR:8090`.

## Instalar no CasaOS

1. A cada push na `main`, o GitHub Actions roda os testes e publica a imagem `ghcr.io/diegoukan/escritorio-hub:latest`.
2. Na primeira vez, deixe o pacote público para o CasaOS conseguir baixar sem login:
   GitHub → seu perfil → **Packages** → `escritorio-hub` → **Package settings** → **Change visibility** → Public.
   (O código continua privado; só a imagem fica pública.)
3. No CasaOS: **App Store** → **+** → **Install a customized app** → **Import** → cole o conteúdo de [`docker-compose.yml`](docker-compose.yml) → Install.
4. Para atualizar: no CasaOS, abra o app e use **Update** (ele baixa a `latest` de novo).

As configurações ficam em `/DATA/AppData/escritorio-hub/config.json` no servidor e não se perdem ao atualizar.

## Configuração

Tudo é feito pela aba **Configurações** da página:

| Campo | O que é |
| --- | --- |
| Dispositivos WLED | ID, nome e endereço de cada ESP32 com WLED. Prefira o **IP** (reserve IP fixo no roteador), porque nomes `.local` nem sempre resolvem dentro do container. |
| PC | IP fixo do PC gamer e a porta TCP usada para saber se ele está ligado. |
| Caixa de som | Qual WLED tem o relé, o número do relé e quanto tempo esperar antes de desligar. |
| OpenRGB | IP do PC e porta do SDK Server (6742). No OpenRGB: aba **SDK Server** → **Start Server**, e marque para iniciar com o Windows. |

## API

| Método | Rota | Corpo |
| --- | --- | --- |
| GET | `/api/status` | — |
| GET/PUT | `/api/config` | configuração (parcial no PUT) |
| POST | `/api/all` | `{ on, bri, color: [r,g,b], fx, pal, sx, ps }` para todos os WLED (+ cor no OpenRGB) |
| POST | `/api/wled/:id` | mesmo corpo, para um WLED |
| GET | `/api/wled/:id/lists` | efeitos e paletas |
| POST | `/api/speaker` | `{ mode: "auto" \| "on" \| "off" }` |
| POST | `/api/openrgb/color` | `{ color: [r,g,b], device?: id }` |
| POST | `/api/openrgb/profile` | `{ name }` |

Isso permite chamar o hub pelo Home Assistant, N8N ou Hermes.

## Desenvolvimento

```bash
npm install
npm test
DATA_DIR=./data npm start   # http://localhost:8090
```
