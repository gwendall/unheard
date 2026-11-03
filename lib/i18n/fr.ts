import type { Dict } from "./en";

// Every word the site shows, in French ("vous"). Written with plain spaces; frenchSpacing() below
// puts the non-breaking ones French typography wants (before : ; ? !, inside « », in 8 000).

const NBSP = " ";
const THIN = " ";

export function frenchSpacing(s: string): string {
  return s
    .replace(/ ([;?!])/g, `${THIN}$1`)
    .replace(/ :/g, `${NBSP}:`)
    .replace(/« /g, `«${NBSP}`)
    .replace(/ »/g, `${NBSP}»`)
    .replace(/(\d) (\d{3})\b/g, `$1${THIN}$2`);
}

function spaced<T>(value: T): T {
  if (typeof value === "string") return frenchSpacing(value) as T;
  if (typeof value === "function") return ((...a: unknown[]) => spaced((value as (...a: unknown[]) => unknown)(...a))) as T;
  if (Array.isArray(value)) return value.map(spaced) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, spaced(v)])) as T;
  return value;
}

export const fr: Dict = spaced<Dict>({
  meta: {
    title: "Unheard : l'avion que vous n'entendez pas",
    shareTitle: "Unheard : votre téléphone nomme l'avion qui passe au-dessus de vous",
    description:
      "Levez votre téléphone vers le ciel quelques minutes. Unheard repère le faible bourdonnement d'un avion dans le bruit et vous dit lequel c'était, d'après les données de vol en direct.",
    ogLocale: "fr_FR",
    ogAlt:
      "Il y a un avion que vous n'entendez pas. Votre téléphone l'entend. Unheard le nomme. Une note ambrée lumineuse s'infléchit sur un spectrogramme bleu nuit, comme la hauteur du son d'un avion qui passe.",
    privacyTitle: "Ce qui est envoyé · Unheard",
  },
  og: { lines: ["Il y a un avion", "que vous n’entendez pas."], sub: "Votre téléphone l’entend. Unheard le nomme.", size: 84 },
  hero: {
    title: "Il y a un avion que vous n'entendez pas.",
    lead: "Votre téléphone, lui, l'entend. Unheard vous montre les avions qui passent près de vous, écoute pendant que l'un d'eux vous survole, et retrouve son faible bourdonnement dans le bruit pour vous dire quel avion c'était.",
    listen: "Écouter le ciel",
    needs: ["Un téléphone, dehors, et une minute ou deux", "Idéal avec les avions à hélice et les hélicoptères", "Votre enregistrement reste sur votre téléphone, sauf si vous choisissez de le donner"],
    qrTitle: "Mieux sur un téléphone, dehors.",
    qrBody: "Visez ce code avec l'appareil photo de votre téléphone pour y ouvrir Unheard.",
  },
  example: {
    label: "Voir un exemple de résultat : un Cessna 172 Skyhawk retrouvé dans un enregistrement simulé",
    chip: "Exemple simulé",
    found: "Trouvé",
    verdict: "C'était un Cessna 172 Skyhawk.",
    open: "Voir cet exemple en entier",
  },
  facts: {
    closest: "de vous, au plus près",
    above: "au-dessus de vous",
    delay: "pour que son bruit vous parvienne",
  },
  how: {
    title: "Comment ça marche",
    steps: [
      {
        title: "Attendez un avion",
        body: "La page vous montre les avions autour de vous d'après les données de vol en direct : lequel passera le plus près, et quand. Les avions à hélice et les hélicoptères ont le bourdonnement le plus régulier, ce sont les plus faciles à trouver.",
      },
      {
        title: "Levez votre téléphone",
        body: "Lancez l'écoute quand la page vous le dit et pointez votre téléphone vers le ciel. Il enregistre une minute ou deux et s'arrête tout seul une fois l'avion passé.",
      },
      {
        title: "Découvrez son nom",
        body: "Son bourdonnement est un peu plus aigu quand il approche, un peu plus grave quand il s'éloigne : c'est l'effet Doppler. Votre téléphone calcule la courbe que chaque avion aurait dû laisser là où vous êtes, retrouve la bonne dans votre enregistrement, et nomme l'avion.",
      },
    ],
  },
  proof: {
    title: "Est-ce que ça marche ?",
    lead: "Chaque changement est testé sur des passages enregistrés avant d'être mis en ligne. Une règle ne plie jamais : quand Unheard dit « C'était », il doit avoir raison.",
    wrong: (n: number, tested: number, nothing: number) =>
      `${n <= 1 ? "erreur" : "erreurs"} quand il dit « C'était », sur ${tested} enregistrements de test, dont ${nothing} sans aucun avion à trouver. Quand la trace est faible, il dit « sans doute ».`,
    realValue: (hit: number, n: number) => `${hit} sur ${n}`,
    real: (strong: number) => `vrais passages enregistrés près d'Adélaïde, bien identifiés : ${strong} avec certitude, les autres en « sans doute ».`,
    yoursValue: "Le vôtre",
    yours: "Les enregistrements faits au téléphone sont le prochain test. Après un résultat, vous pouvez donner le vôtre, sans lieu ni heure.",
    measured: (date: string) => `Dernière mesure le ${date}.`,
    scoreboard: "Tous les chiffres et leur mesure (en anglais)",
  },
  sky: {
    errors: {
      location: "Unheard a besoin de votre position pour savoir quels avions sont autour de vous. Autorisez-la pour ce site et réessayez.",
      microphone: "Unheard a besoin du micro pour écouter. Autorisez-le pour ce site et réessayez.",
      recorder: "Ce navigateur n'a pas pu ouvrir le micro pour enregistrer. Essayez un autre navigateur.",
      nothing: "Rien n'a été enregistré. Vérifiez que le micro fonctionne et réessayez.",
    },
    locating: { title: "Où êtes-vous ?", text: "Unheard a besoin de votre zone approximative pour savoir quels avions sont autour de vous. Seul un carré d'environ 10 km quitte votre téléphone." },
    asking: { title: "Autorisez le micro", text: "Unheard écoute le bourdonnement d'un avion. Le son reste sur votre téléphone." },
    listening: {
      title: "À l'écoute",
      hold: (left: number) => `Ne bougez plus. Continuez encore au moins ${left} secondes.`,
      stop: "Arrêtez une fois qu'un avion est passé. Les hélices et les rotors marchent le mieux.",
    },
    coming: {
      title: (name: string) => `${name} approche`,
      text: (when: string, distance: string) => `Au plus près dans ${when}, à ${distance} de vous. Ne bougez plus, micro vers le ciel.`,
    },
    passing: { title: (name: string) => `${name} passe`, text: "Ne bougez plus : c'est le moment qui compte." },
    passed: {
      title: (name: string) => `${name} est passé`,
      more: (left: number) => `Continuez encore ${left} secondes.`,
      stopping: (inSeconds: number) => `Arrêt automatique dans ${inSeconds} s, ou arrêtez maintenant.`,
    },
    paused: { title: "En pause", text: "La page a cessé de surveiller le ciel au bout de 10 minutes, pour ménager le service gratuit qui suit les avions." },
    looking: { title: "Le ciel autour de vous", text: "Recherche de tous les avions dans un rayon de 30 km." },
    chance: {
      title: (name: string, distance: string, when: string) => `${name} passe à ${distance} de vous dans ${when}.`,
      text: "Lancez l'écoute maintenant et gardez votre téléphone immobile, micro vers le ciel. Elle s'arrête toute seule une fois l'avion passé.",
    },
    now: { title: (name: string, distance: string) => `${name} est à ${distance} de vous en ce moment.`, text: "Lancez l'écoute maintenant et gardez votre téléphone immobile, micro vers le ciel." },
    quiet: {
      title: "Ciel calme pour l'instant",
      text: (count: number, nearest: string) =>
        `${count} ${count === 1 ? "avion" : "avions"} autour, aucun assez près pour l'entendre.${nearest} Les avions à hélice et les hélicoptères à quelques km marchent le mieux. Cette page continue de surveiller : laissez-la ouverte.`,
      nearest: (name: string, distance: string, up: string) => ` Le plus proche, ${name}, est à ${distance} et à ${up} d'altitude.`,
    },
    empty: { title: "Aucun avion à moins de 30 km", text: "Cette page continue de surveiller : laissez-la ouverte, la liste se remplit quand des avions arrivent." },
    start: "Lancer l'écoute",
    anyway: "Écouter quand même",
    watch: "Continuer à surveiller",
    stop: "Arrêter et trouver l'avion",
    cancel: "Annuler",
    analyzing: {
      title: "Recherche de l'avion dans votre enregistrement",
      checking: (i: number, n: number) => `Vérification de l'avion ${i} sur ${n}`,
      reading: "Lecture du son",
    },
  },
  hearIt: {
    title: "Écoutez-le",
    yours: "Votre enregistrement",
    yoursText: "Tel que votre téléphone l'a entendu, juste plus fort. Entendez-vous un avion dedans ?",
    plane: "L'avion, révélé",
    planeText: (speed: number) =>
      `${speed > 1 ? `Le même enregistrement ${({ 2: "deux fois", 4: "quatre fois", 8: "huit fois" } as Record<number, string>)[speed] ?? `${speed} fois`} plus vite, pour que son bourdonnement grave monte là où un haut-parleur de téléphone peut le jouer, ` : "Le même enregistrement, "}filtré sur la bande de sa courbe. Le son qui glisse vers le grave, c'est l'effet Doppler.`,
    preparing: "Préparation…",
  },
  share: {
    button: "Partager ce que votre téléphone a entendu",
    busy: "Création de l'image…",
    saved: "L'image est enregistrée et le texte copié : collez-les où vous voulez.",
    error: "Impossible de créer l'image dans ce navigateur.",
  },
  plots: {
    you: "Vous",
    spectrum: "Spectre de l'enregistrement autour de la note de l'avion",
    map: "Carte des vols autour de vous pendant l'enregistrement",
    live: "Spectre en direct de ce qu'entend le micro",
  },
  route: (from: string, to: string) => `${from} → ${to}`,
  list: {
    title: "Autour de vous en ce moment",
    up: (height: string) => `à ${height}`,
    passingNow: "passe maintenant",
    movingAway: "s'éloigne",
    closestIn: (when: string, distance: string) => `au plus près dans ${when}, ${distance}`,
    farOff: "loin",
    audible: "audible",
    legend: "assez près pour l'entendre. Noms fournis par adsbdb.com.",
  },
  result: {
    found: "Trouvé",
    faint: "Une trace faible",
    nothing: "Rien de net",
    strong: (name: string) => `C'était ${name}.`,
    possible: (name: string) => `Sans doute ${name}.`,
    none: "Aucun avion ne correspond.",
    guess: "La trace est faible : prenez-le comme une bonne hypothèse.",
    noneText: (seen: number) =>
      `Nous avons comparé votre enregistrement à ${seen} ${seen === 1 ? "avion" : "avions"} autour de vous. Aucun n'a laissé de trace nette. Réessayez quand l'un d'eux passe à quelques kilomètres, idéalement un avion à hélice ou un hélicoptère : l'écran du ciel vous dit quand.`,
    photographed: (title: string) => `${title}, en photo`,
    theAircraft: "L'avion",
    photo: "Photo",
    speed: "sa vitesse",
    hum: { prop: "la note du bourdonnement de son hélice", rotor: "la note du battement de son rotor", jet: "la note du bourdonnement de ses moteurs", any: "la note de son bourdonnement" },
    fall: "plus grave en s'éloignant : l'effet Doppler",
    shareText: (possible: boolean, name: string, distance: string) => `Mon téléphone a ${possible ? "sans doute " : ""}entendu ${name} que je n'entendais pas, à ${distance}.`,
    shareLead: (possible: boolean) => (possible ? "Mon téléphone a sans doute entendu" : "Mon téléphone a entendu"),
    shareFacts: { closest: "de moi, au plus près", above: "au-dessus de moi", delay: "pour que son bruit me parvienne" },
    curveShown: "Les rails montrent la courbe que ce vol aurait dû laisser dans votre enregistrement. La ligne entre les deux, c'est ce qu'a entendu votre téléphone.",
    curveHidden: "Votre enregistrement, zoomé sur la bande où la note a bougé. Vous voyez la faible ligne courbée ?",
    band: "Votre enregistrement entre 40 et 300 Hz.",
    showCurve: "Montrer la courbe de l'avion",
    hideCurve: "Cacher la courbe",
    checked: (n: number) => `Tous les avions vérifiés (${n})`,
    atClosest: (distance: string) => `${distance} au plus près`,
    jet: "réacteur",
    score: (strong: number) => `Le score dit à quel point la courbe de chaque avion se détache du hasard dans votre enregistrement. Sans avion à trouver, aucun score n'a atteint ${strong} dans nos tests.`,
    realSky: "Écouter le vrai ciel",
    again: "Écouter à nouveau",
    bundle: "Télécharger l'enregistrement complet",
  },
  donate: {
    thanks: "Merci, c'est reçu.",
    removal: (id: string) => [`Don `, id, `. Écrivez à `, `unheard@gwendall.com`, ` avec cet identifiant pour faire retirer l'enregistrement.`],
    title: "Donner cet enregistrement au jeu de données",
    why: "Chaque vrai enregistrement dont on connaît la réponse aide Unheard à mieux entendre les avions. Il quitte votre téléphone sans votre position, sans l'heure et sans l'identité d'aucun avion.",
    whatIsSent: "Ce qui est envoyé",
    listen: "Écoutez ce que vous enverriez",
    heard: "Qu'avez-vous entendu ?",
    atClosest: (distance: string) => `, ${distance} au plus près`,
    none: "Aucun avion",
    unsure: "Je ne sais pas, ou un avion absent de la liste",
    note: "Ce que vous avez vu ou entendu, si vous voulez (rien de personnel)",
    placeholder: "Un petit avion est passé bas au nord, un hélicoptère au loin.",
    consent: "Je donne cet enregistrement au jeu de données Unheard. Il pourra être publié sous licence CC BY 4.0 après une relecture qui coupe toute voix.",
    failed: "Envoi impossible :",
    sending: "Envoi…",
    give: "Donner cet enregistrement",
  },
  logbook: {
    title: (n: number) => `Vos avions (${n})`,
    note: "Gardés sur ce téléphone uniquement. Rien n'en est envoyé.",
    clear: "Effacer",
    confirmClear: "Effacer la liste de vos avions sur ce téléphone ?",
    probably: "sans doute",
    away: (distance: string) => `à ${distance}`,
    more: (n: number) => `Voir les ${n}`,
    less: "En voir moins",
    added: (n: number) => `Ajouté à vos avions sur ce téléphone (${n}).`,
  },
  follow: "Le suivre en direct",
  footer: {
    github: "Code ouvert sur GitHub",
    privacy: "Confidentialité",
    madeBy: "Made by Gwendall",
    other: { label: "English", lang: "en" },
  },
  privacy: {
    title: "Ce qui est envoyé",
    sections: [
      {
        title: "Quand vous écoutez",
        body: [
          "Votre enregistrement est analysé sur votre téléphone et y reste. La page demande à notre serveur les avions autour de vous avec votre position arrondie à environ 10 km, puis l'altitude du sol et la température avec votre position arrondie à environ 100 m. Unheard ne garde ni l'une ni l'autre ; les journaux de requêtes de l'hébergeur les conservent peu de temps. Pour donner leur nom aux avions (compagnie, trajet, modèle), la page interroge adsbdb.com sur les avions autour de vous par leurs codes, jamais avec votre position, et le serveur d'Unheard demande à planespotters.net une photo de celui qu'il a trouvé, par son code aussi. Rien d'autre ne quitte votre téléphone.",
          "Les avions que vous avez trouvés sont gardés dans le stockage de ce navigateur pour afficher votre liste sur l'accueil. Rien n'en est envoyé, et « Effacer » la supprime.",
        ],
      },
      {
        title: "Quand vous donnez un enregistrement",
        body: [
          "Seulement si vous cochez la case et appuyez sur le bouton. Avant tout envoi, votre téléphone réécrit les données de vol de l'enregistrement pour qu'elles montrent la même scène nulle part et à aucun moment : vous êtes déplacé à 0° 0° au niveau de la mer, chaque avion garde sa position par rapport à vous, toute la scène est tournée d'un angle aléatoire pour qu'aucune piste ni trajectoire d'approche ne trahisse le lieu, l'horloge est ramenée au 1er janvier 2000, et les avions perdent leur adresse, leur numéro de vol et leur immatriculation (ils gardent leur type, comme C172). L'angle et les décalages ne sont jamais envoyés.",
          "Ce qui est envoyé : le son (8 000 échantillons par seconde, la fréquence qu'utilise l'analyse), les données de vol anonymisées, la température, la réponse de la page, ce que vous avez dit avoir entendu et votre note, le nom et la version de votre navigateur, et les réglages audio de votre micro. Ni votre position, ni l'heure, ni les identifiants de votre appareil. L'envoi va dans un stockage privé ; votre adresse n'y est pas associée.",
        ],
      },
      {
        title: "Ce qu'il devient",
        body: [
          "Chaque enregistrement est vérifié par un programme puis par une personne avant de rejoindre le jeu de données public sur lequel le projet se teste. Les passages avec des voix sont coupés. Le jeu de données est publié sous licence CC BY 4.0 : chacun peut l'utiliser en citant la source.",
          "Après l'envoi, la page affiche l'identifiant du don. Écrivez à unheard@gwendall.com avec cet identifiant pour faire retirer l'enregistrement, avant ou après publication.",
        ],
      },
    ],
  },
});
