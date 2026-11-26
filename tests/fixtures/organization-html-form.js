// A fictional organization form for REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030
// tests. "Pat Example", "Unit 9" and the rest are invented sample answers that
// the blanking step must remove; nothing here comes from a supplied form.
export const OFFICIAL_BUILDER = "window.buildOfficialPdf = function () { return 'official layout'; };";

export const FILLED_SAMPLE_FORM = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Example Step One Grievance</title>
<script>window._sigPads = { padA: { getData: function () { return window.__padData || null; }, setData: function (data) { window.__restored = data; } } };</script>
</head>
<body>
<form id="official">
<label for="name">Grievant name</label><input id="name" value="Pat Example" data-default="Pat Example">
<label for="unit">Bargaining unit</label><input id="unit" readonly value="Unit 9">
<label for="phone">Work phone</label><input id="phone" type="tel" value="555-0100">
<label><input type="checkbox" id="agree" checked> I agree</label>
<label><input type="radio" name="step" value="one" checked> Step one</label>
<label><input type="radio" name="step" value="two"> Step two</label>
<label for="statement">Statement</label><textarea id="statement">An earlier statement</textarea>
<label for="dept">Department</label><select id="dept"><option value="intake" selected>Intake</option><option value="review">Review</option></select>
<input type="hidden" id="mirror" value="data:image/png;base64,AAAA">
<button type="button" onclick="window.buildOfficialPdf()">Official PDF</button>
<div class="sig-box"><img id="sig-image" alt="Signature" src="data:image/png;base64,SIGNATURE"></div>
<img id="emblem" alt="Emblem" src="data:image/png;base64,EMBLEM">
</form>
<section class="ug-html-actions"><button type="button">Save HTML</button></section>
<script id="ug-html-export">window.ugSaveHTML = function () {};</script>
<script>${OFFICIAL_BUILDER}</script>
</body>
</html>`;
