let pin = [];
const parse = require('csv-parse/lib/sync');
const fs = require('fs');

const csvData = fs.readFileSync('moi_blr_pin.csv', 'utf8');

const records = parse(csvData, {
    columns: true,
    skip_empty_lines: true
});

records.forEach(element => {
    pin.push(parseInt(element.pincode));
});

let rawdata = fs.readFileSync('INPUT.json');
let user_input = JSON.parse(rawdata);
pin = [...new Set(pin)];
pin.sort();
user_input.postalCodeArray = pin;

fs.writeFileSync("INPUT.json", JSON.stringify(user_input,null, '\t')); 