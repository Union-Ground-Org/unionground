// Generated from the Unicode confusables data, UTS #39 confusables.txt version 18.0.0
// (https://www.unicode.org/Public/18.0.0/security/confusables.txt, sha256:6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92),
// with letter categories and names from Unicode 16.0.0 (Python's unicodedata). Unicode data:
// copyright Unicode, Inc., under the terms at https://www.unicode.org/terms_of_use.html.
// Rebuild, never edit by hand: python3 -I scripts/union-catalog/build-look-alike-letters.py
// <confusables.txt> > scripts/union-catalog/look-alike-letters.mjs.
// Rows: every letter the data reads as one basic Latin letter, alone or followed only by marks,
// less the letters NFKD already reads as a basic Latin letter or as another row; every Latin
// small capital, as its small letter; Greek small kappa as k and chi as x (reviewed additions);
// and the Cherokee small letters, which take their capital's letter. A row read as "l" is also
// read as "I" by foldLookAlikes.
// SEC-UG-CATALOG-PRIVACY-FILTER-LOOK-ALIKE-LETTERS-AND-TWICE-ENCODED-URLS-20261115 (#8766).
// Detection only (foldLookAlikes in privacy-filter.mjs): never an exported value, a key or a hash.
export const LOOK_ALIKE_LETTERS = new Map(Object.entries({
  // Ahom
  "\u{11706}": "v", "\u{1170A}": "w", "\u{1170E}": "w", "\u{1170F}": "w",
  // Arabic
  "\u0627": "l", "\u0629": "o", "\u0647": "o", "\u0673": "l", "\u06BE": "o", "\u06C1": "o", "\u06C3": "o",
  "\u06D5": "o", "\u06FF": "o",
  // Armenian
  "\u054D": "U", "\u054F": "S", "\u0555": "O", "\u0561": "w", "\u0563": "q", "\u0566": "q", "\u0570": "h",
  "\u0572": "n", "\u0575": "j", "\u0578": "n", "\u057C": "n", "\u057D": "u", "\u0581": "g", "\u0582": "i",
  "\u0584": "f", "\u0585": "o",
  // Bamum
  "\uA6A2": "o", "\uA6B2": "Y", "\uA6C9": "Z", "\uA6DF": "V", "\u{1699B}": "O", "\u{16A19}": "r",
  // Bassa
  "\u{16AD6}": "S", "\u{16AE4}": "l", "\u{16AE9}": "O",
  // Bopomofo
  "\u3112": "T", "\u311A": "Y",
  // Canadian
  "\u142F": "V", "\u144C": "U", "\u146D": "P", "\u146F": "d", "\u1472": "b", "\u1473": "b", "\u148D": "J",
  "\u14AA": "L", "\u1541": "x", "\u157C": "H", "\u157D": "x", "\u1587": "R", "\u15AF": "b", "\u15B4": "F",
  "\u15C5": "A", "\u15DE": "D", "\u15EA": "D", "\u15F0": "M", "\u15F7": "B", "\u{11ABC}": "Z", "\u{11ABE}": "N",
  // Carian
  "\u{102A0}": "A", "\u{102A1}": "B", "\u{102A2}": "C", "\u{102A5}": "F", "\u{102AB}": "O", "\u{102B0}": "M",
  "\u{102B1}": "T", "\u{102B2}": "Y", "\u{102B4}": "X", "\u{102CF}": "H",
  // Chakma
  "\u{11116}": "o", "\u{11124}": "o",
  // Cherokee
  "\u13A0": "D", "\u13A1": "R", "\u13A2": "T", "\u13A4": "O", "\u13A5": "i", "\u13A9": "Y", "\u13AA": "A",
  "\u13AB": "J", "\u13AC": "E", "\u13B3": "W", "\u13B7": "M", "\u13BB": "H", "\u13BD": "Y", "\u13BE": "O",
  "\u13BF": "t", "\u13C0": "G", "\u13C2": "h", "\u13C3": "Z", "\u13CC": "U", "\u13CF": "b", "\u13D2": "R",
  "\u13D4": "W", "\u13D5": "S", "\u13D9": "V", "\u13DA": "S", "\u13DE": "L", "\u13DF": "C", "\u13E2": "P",
  "\u13E6": "K", "\u13E7": "d", "\u13EB": "O", "\u13F2": "h", "\u13F3": "G", "\u13F4": "B", "\u13FA": "h",
  "\u13FB": "g", "\u13FC": "b", "\uAB70": "d", "\uAB71": "r", "\uAB72": "t", "\uAB74": "o", "\uAB75": "i",
  "\uAB79": "y", "\uAB7A": "a", "\uAB7B": "j", "\uAB7C": "e", "\uAB81": "r", "\uAB83": "w", "\uAB87": "m",
  "\uAB8B": "h", "\uAB8D": "y", "\uAB8E": "o", "\uAB8F": "t", "\uAB90": "g", "\uAB92": "h", "\uAB93": "z",
  "\uAB9C": "u", "\uAB9F": "b", "\uABA2": "r", "\uABA4": "w", "\uABA5": "s", "\uABA9": "v", "\uABAA": "s",
  "\uABAE": "l", "\uABAF": "c", "\uABB2": "p", "\uABB6": "k", "\uABB7": "d", "\uABBB": "o",
  // Cjk
  "\u4E05": "T", "\u4E2B": "Y",
  // Coptic
  "\u03ED": "o", "\u2C82": "B", "\u2C85": "r", "\u2C8C": "Z", "\u2C8D": "z", "\u2C8E": "H", "\u2C90": "O",
  "\u2C91": "o", "\u2C92": "l", "\u2C93": "i", "\u2C94": "K", "\u2C98": "M", "\u2C9A": "N", "\u2C9E": "O",
  "\u2C9F": "o", "\u2CA2": "P", "\u2CA3": "p", "\u2CA4": "C", "\u2CA5": "c", "\u2CA6": "T", "\u2CA8": "Y",
  "\u2CA9": "y", "\u2CAC": "X", "\u2CBD": "w", "\u2CCE": "P", "\u2CCF": "p", "\u2CD0": "L",
  // Cyrillic
  "\u0405": "S", "\u0406": "l", "\u0408": "J", "\u0410": "A", "\u0411": "b", "\u0412": "B", "\u0415": "E",
  "\u041A": "K", "\u041C": "M", "\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T",
  "\u0423": "Y", "\u0425": "X", "\u042C": "b", "\u0430": "a", "\u0433": "r", "\u0435": "e", "\u043E": "o",
  "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0448": "w", "\u0455": "s", "\u0456": "i",
  "\u0458": "j", "\u045B": "h", "\u045F": "u", "\u0461": "w", "\u0462": "b", "\u0463": "b", "\u0472": "O",
  "\u0473": "o", "\u0474": "V", "\u0475": "v", "\u047D": "w", "\u048C": "b", "\u048D": "b", "\u0493": "r",
  "\u049A": "K", "\u049E": "K", "\u04A2": "H", "\u04AA": "C", "\u04AB": "c", "\u04AC": "T", "\u04AE": "Y",
  "\u04AF": "y", "\u04B0": "Y", "\u04B1": "y", "\u04B2": "X", "\u04BA": "h", "\u04BB": "h", "\u04BD": "e",
  "\u04BF": "e", "\u04C0": "l", "\u04C7": "H", "\u04C9": "H", "\u04CD": "M", "\u04CF": "l", "\u04E8": "O",
  "\u04E9": "o", "\u0501": "d", "\u050C": "G", "\u051A": "Q", "\u051B": "q", "\u051C": "W", "\u051D": "w",
  "\u1C82": "o", "\u1C83": "c", "\uA647": "i", "\uA68C": "T", "\uA695": "h",
  // Deseret
  "\u{10404}": "O", "\u{10415}": "C", "\u{1041B}": "L", "\u{10420}": "S", "\u{1042C}": "o", "\u{1043D}": "c",
  "\u{10448}": "s",
  // Elbasan
  "\u{10507}": "Z", "\u{1050E}": "l", "\u{10513}": "N", "\u{10516}": "O", "\u{10518}": "K", "\u{1051B}": "C",
  "\u{1051D}": "V", "\u{1051E}": "O", "\u{10525}": "F", "\u{10526}": "L", "\u{10527}": "X",
  // Ethiopic
  "\u1200": "U", "\u12D0": "O", "\u1340": "O",
  // Georgian
  "\u10B9": "h", "\u10BD": "S", "\u10CD": "Z", "\u10D7": "o", "\u10E7": "y", "\u10FD": "S", "\u10FF": "o",
  "\u1CBD": "S", "\u1CBF": "O", "\u2D2D": "z",
  // Greek
  "\u037F": "J", "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0398": "O",
  "\u0399": "l", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O", "\u03A1": "P", "\u03A4": "T",
  "\u03A5": "Y", "\u03A7": "X", "\u03B1": "a", "\u03B3": "y", "\u03B7": "n", "\u03B8": "O", "\u03B9": "i",
  "\u03BA": "k", "\u03BD": "v", "\u03BF": "o", "\u03C1": "p", "\u03C3": "o", "\u03C5": "u", "\u03C7": "x",
  "\u03DC": "F", "\u03F2": "c", "\u03F3": "j", "\u03F8": "p", "\u03F9": "C", "\u03FA": "M", "\u1D26": "r",
  // Hangul
  "\u110B": "o", "\u11BC": "o",
  // Hanifi
  "\u{10D07}": "o",
  // Hebrew
  "\u05D5": "l", "\u05D8": "v", "\u05DF": "l", "\u05E1": "o",
  // Kirat
  "\u{16D63}": "l",
  // Latin
  "\u00D0": "D", "\u00D8": "O", "\u00F8": "o", "\u00FE": "p", "\u0110": "D", "\u0111": "d", "\u0126": "H",
  "\u0127": "h", "\u0131": "i", "\u0141": "L", "\u0142": "l", "\u014B": "n", "\u0166": "T", "\u0167": "t",
  "\u0180": "b", "\u0182": "b", "\u0183": "b", "\u0184": "b", "\u0189": "D", "\u018B": "d", "\u018C": "d",
  "\u018D": "g", "\u0191": "F", "\u0192": "f", "\u0196": "l", "\u0197": "l", "\u0199": "k", "\u019A": "l",
  "\u019D": "N", "\u019E": "n", "\u019F": "O", "\u01A5": "p", "\u01A6": "R", "\u01AB": "t", "\u01AD": "t",
  "\u01AE": "T", "\u01B4": "y", "\u01B5": "Z", "\u01B6": "z", "\u01BD": "s", "\u01BF": "p", "\u01C0": "l",
  "\u01E4": "G", "\u01E5": "g", "\u0224": "Z", "\u0225": "z", "\u0237": "j", "\u023C": "c", "\u023E": "T",
  "\u0244": "U", "\u0246": "E", "\u0247": "e", "\u0248": "J", "\u0249": "j", "\u024C": "R", "\u024D": "r",
  "\u024E": "Y", "\u024F": "y", "\u0251": "a", "\u0253": "b", "\u0256": "d", "\u0257": "d", "\u025F": "j",
  "\u0260": "g", "\u0261": "g", "\u0262": "g", "\u0263": "y", "\u0266": "h", "\u0268": "i", "\u0269": "i",
  "\u026A": "i", "\u026B": "l", "\u026D": "l", "\u026F": "w", "\u0272": "n", "\u0273": "n", "\u0274": "n",
  "\u0275": "o", "\u027C": "r", "\u027D": "r", "\u0280": "r", "\u0282": "s", "\u0284": "f", "\u028B": "u",
  "\u028F": "y", "\u0290": "z", "\u0299": "b", "\u029C": "h", "\u029F": "l", "\u02A0": "q", "\u1D00": "a",
  "\u1D04": "c", "\u1D05": "d", "\u1D07": "e", "\u1D0A": "j", "\u1D0B": "k", "\u1D0D": "m", "\u1D0F": "o",
  "\u1D11": "o", "\u1D18": "p", "\u1D1B": "t", "\u1D1C": "u", "\u1D20": "v", "\u1D21": "w", "\u1D22": "z",
  "\u1D6E": "f", "\u1D70": "n", "\u1D72": "r", "\u1D74": "s", "\u1D75": "t", "\u1D76": "z", "\u1D7B": "i",
  "\u1D7C": "i", "\u1D7D": "p", "\u1D7E": "u", "\u1D83": "g", "\u1D8C": "y", "\u1E9D": "f", "\u1EFF": "y",
  "\u2C67": "H", "\u2C69": "K", "\u2C6B": "Z", "\u2C6C": "z", "\uA730": "f", "\uA731": "s", "\uA740": "K",
  "\uA74A": "O", "\uA74B": "o", "\uA761": "w", "\uA781": "l", "\uA798": "F", "\uA799": "f", "\uA79F": "u",
  "\uA7AE": "l", "\uA7AF": "q", "\uA7B2": "J", "\uA7B3": "X", "\uA7B4": "B", "\uA7C5": "S", "\uA7FA": "w",
  "\uA7FE": "l", "\uAB32": "e", "\uAB35": "f", "\uAB3D": "o", "\uAB3E": "o", "\uAB47": "r", "\uAB48": "r",
  "\uAB4E": "u", "\uAB52": "u", "\uAB5A": "y", "\uAB64": "a",
  // Lisu
  "\uA4D0": "B", "\uA4D1": "P", "\uA4D2": "d", "\uA4D3": "D", "\uA4D4": "T", "\uA4D6": "G", "\uA4D7": "K",
  "\uA4D9": "J", "\uA4DA": "C", "\uA4DC": "Z", "\uA4DD": "F", "\uA4DF": "M", "\uA4E0": "N", "\uA4E1": "L",
  "\uA4E2": "S", "\uA4E3": "R", "\uA4E6": "V", "\uA4E7": "H", "\uA4EA": "W", "\uA4EB": "X", "\uA4EC": "Y",
  "\uA4EE": "A", "\uA4F0": "E", "\uA4F2": "l", "\uA4F3": "O", "\uA4F4": "U",
  // Lycian
  "\u{10282}": "B", "\u{10286}": "E", "\u{10287}": "F", "\u{1028A}": "l", "\u{10290}": "X", "\u{10292}": "O",
  "\u{10295}": "P", "\u{10296}": "S", "\u{10297}": "T",
  // Lydian
  "\u{10926}": "l", "\u{1092C}": "o",
  // Malayalam
  "\u0D1F": "s", "\u0D20": "o",
  // Mandaic
  "\u0840": "o",
  // Miao
  "\u{16F08}": "V", "\u{16F0A}": "T", "\u{16F16}": "L", "\u{16F28}": "l", "\u{16F35}": "R", "\u{16F3A}": "S",
  "\u{16F40}": "A", "\u{16F42}": "U", "\u{16F43}": "Y",
  // Myanmar
  "\u1004": "c", "\u1010": "o", "\u101D": "o", "\u105A": "c",
  // Nko
  "\u07CA": "l", "\u07CB": "o", "\u07CC": "Y", "\u07D3": "F", "\u07D5": "b", "\u07E0": "T",
  // Old
  "\u{10301}": "B", "\u{10302}": "C", "\u{10309}": "l", "\u{1030F}": "O", "\u{10311}": "M", "\u{10315}": "T",
  "\u{10317}": "X", "\u{1031C}": "b", "\u{10C13}": "X", "\u{10C17}": "O", "\u{10C1F}": "V", "\u{10C20}": "Y",
  "\u{10C21}": "M", "\u{10C3E}": "l", "\u{10C82}": "X", "\u{10CA5}": "l", "\u{10CC2}": "x",
  // Oriya
  "\u0B20": "O",
  // Osage
  "\u{104B4}": "R", "\u{104C2}": "O", "\u{104CE}": "U", "\u{104EA}": "o", "\u{104F6}": "u",
  // Runic
  "\u16B7": "X", "\u16C1": "l", "\u16C5": "l", "\u16D0": "l", "\u16D5": "K", "\u16D6": "M",
  // Tagbanwa
  "\u1763": "x",
  // Tai
  "\u1A32": "o", "\u1A45": "o",
  // Tifinagh
  "\u2D31": "O", "\u2D38": "V", "\u2D39": "E", "\u2D41": "O", "\u2D4A": "l", "\u2D4F": "l", "\u2D54": "O",
  "\u2D55": "Q", "\u2D5D": "X",
  // Tirhuta
  "\u{114C5}": "w",
  // Vai
  "\uA50B": "T", "\uA557": "B", "\uA56F": "l", "\uA576": "S", "\uA5CB": "E",
  // Vedic
  "\u1CF5": "X",
  // Warang
  "\u{118A0}": "V", "\u{118A2}": "F", "\u{118A3}": "L", "\u{118A4}": "Y", "\u{118A6}": "E", "\u{118A9}": "Z",
  "\u{118AE}": "E", "\u{118B2}": "L", "\u{118B5}": "O", "\u{118B8}": "U", "\u{118BC}": "T", "\u{118C0}": "v",
  "\u{118C1}": "s", "\u{118C2}": "F", "\u{118C3}": "i", "\u{118C4}": "y", "\u{118C8}": "o", "\u{118D7}": "o",
  "\u{118D8}": "u", "\u{118DC}": "y",
}));
