// Decide se a caixa de som deve estar ligada.
// auto: liga quando o PC está online; desliga depois de offDelaySec sem resposta.
export class SpeakerLogic {
  constructor() {
    this.lastSeen = 0;
    this.desired = false;
  }

  update({ mode, pcOnline, offDelaySec, now = Date.now() }) {
    if (pcOnline) this.lastSeen = now;
    if (mode === 'on') this.desired = true;
    else if (mode === 'off') this.desired = false;
    else if (pcOnline) this.desired = true;
    else if (this.desired && now - this.lastSeen >= offDelaySec * 1000) this.desired = false;
    return this.desired;
  }
}
