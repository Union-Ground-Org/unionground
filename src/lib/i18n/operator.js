// "Who runs this server" (the public /operator page and the links to it) and
// the source-code line every about and legal screen carries, split out of the
// src/lib/i18n.js barrel like getApp.js. This file is the ONLY declaration of
// every `operator.` and `source.` key.
//
// Anyone may run a copy of this software, so a person must always be able to
// see who runs the server in front of them, and that it is not Union Ground
// LLC unless it is the official service. "Union Ground LLC" names the company
// and is never rewritten to a copy's own name.
export const operatorCatalogue = {
  en: {
    "operator.link": "Who runs this server",
    "operator.title": "Who runs this server",
    "operator.eyebrow": "Public information",
    "operator.intro": "Anyone may run a copy of this software. This page says who runs the server you are using and how to reach them.",
    "operator.runBy": "Run by",
    "operator.contact": "Contact",
    "operator.website": "Website",
    "operator.jurisdiction": "Jurisdiction",
    "operator.notOfficial": "This server is run by {operator}, not by Union Ground LLC.",
    "operator.official": "This is the official Union Ground service, run by Union Ground LLC.",
    "operator.unset": "This server has not said who runs it. Do not sign in or share anything with it until it does.",
    "operator.officialBadge": "Official Union Ground service",
    "operator.detailsTitle": "Who runs it",
    "operator.sourceTitle": "Source code",
    "source.attributionLabel": "Attribution",
    "source.link": "Source code",
    "source.license": "This software is free software under the GNU Affero General Public License, version 3. You can get the source code of the version this server runs.",
    "source.operatorNote": "Running a modified copy? Set SOURCE_CODE_URL to your own source code so this link offers it, as the license requires.",
  },
  es: {
    "operator.link": "Quién administra este servidor",
    "operator.title": "Quién administra este servidor",
    "operator.eyebrow": "Información pública",
    "operator.intro": "Cualquier persona puede administrar una copia de este programa. Esta página dice quién administra el servidor que estás usando y cómo comunicarte con esa persona u organización.",
    "operator.runBy": "Administrado por",
    "operator.contact": "Contacto",
    "operator.website": "Sitio web",
    "operator.jurisdiction": "Jurisdicción",
    "operator.notOfficial": "Este servidor lo administra {operator}, no Union Ground LLC.",
    "operator.official": "Este es el servicio oficial de Union Ground, administrado por Union Ground LLC.",
    "operator.unset": "Este servidor no ha dicho quién lo administra. No entres ni compartas nada con él hasta que lo diga.",
    "operator.officialBadge": "Servicio oficial de Union Ground",
    "operator.detailsTitle": "Quién lo administra",
    "operator.sourceTitle": "Código fuente",
    "source.attributionLabel": "Atribución",
    "source.link": "Código fuente",
    "source.license": "Este programa es software libre bajo la Licencia Pública General Affero de GNU, versión 3. Puedes obtener el código fuente de la versión que usa este servidor.",
    "source.operatorNote": "¿Administras una copia modificada? Pon en SOURCE_CODE_URL la dirección de tu propio código fuente para que este enlace lo ofrezca, como exige la licencia.",
  },
};
