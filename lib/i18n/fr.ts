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
  footer: {
    github: "Code ouvert sur GitHub",
    privacy: "Confidentialité",
    madeBy: "Made by Gwendall",
  },
  privacy: {
    title: "Ce qui est envoyé",
    sections: [
      {
        title: "Quand vous écoutez",
        body: [
          "Votre enregistrement est analysé sur votre téléphone et y reste. La page demande à notre serveur les avions autour de vous avec votre position arrondie à environ 10 km, puis l'altitude du sol et la température avec votre position arrondie à environ 100 m. Unheard ne garde ni l'une ni l'autre ; les journaux de requêtes de l'hébergeur les conservent peu de temps. Pour donner leur nom aux avions (compagnie, trajet, modèle), la page interroge adsbdb.com sur les avions autour de vous par leurs codes, jamais avec votre position, et le serveur d'Unheard demande à planespotters.net une photo de celui qu'il a trouvé, par son code aussi. Rien d'autre ne quitte votre téléphone.",
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
