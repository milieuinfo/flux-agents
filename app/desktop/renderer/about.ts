/**
 * About-sectie: toont hetzelfde kaartje als het opstart-splashscreen
 * (logo, naam, versie, builddatum). Sectie binnen het gecombineerde
 * InfoPanel (tab "Over"); het InfoPanel levert overlay, tabs en sluitknop.
 *
 * Versie/naam/datum komen uit build-time constanten die esbuild via `define`
 * substitueert (zie desktop/build.mjs) - dezelfde bron als splash.html.
 */
export class AboutPanel {
  readonly element = document.createElement('div');

  constructor() {
    this.element.className = 'info-section about-section';
    this.build();
  }

  private build(): void {
    const logo = document.createElement('img');
    logo.className = 'about-logo';
    logo.src = './logo.png';
    logo.alt = 'logo';

    const name = document.createElement('div');
    name.className = 'about-name';
    name.textContent = __APP_NAME__;

    const meta = document.createElement('div');
    meta.className = 'about-meta';
    meta.innerHTML =
      `versie <b>${__APP_VERSION__}</b><br />build <b>${__BUILD_DATE__}</b>`;

    this.element.append(logo, name, meta);
  }
}
