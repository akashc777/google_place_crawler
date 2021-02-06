const parse = require('csv-parse/lib/sync');
const fs = require('fs');
const ObjectsToCsv = require('objects-to-csv');

const all_csv_global = {};

const not_there = [];

const ac_all_csv = fs.readFileSync('AC_Zoom1.csv', 'utf8');
const ac_jaynagar_csv = fs.readFileSync('AC_malleswaram.csv', 'utf8');


const ac_all = parse(ac_all_csv, {
    columns: true,
    skip_empty_lines: true
});

ac_all.forEach(function(ele){
    all_csv_global[ele.placeId] = ele;
});

const ac_jaynagar = parse(ac_jaynagar_csv, {
    columns: true,
    skip_empty_lines: true
});

ac_jaynagar.forEach(function(ele){

    if(!(ele.placeId in all_csv_global)){
        not_there.push(ele);
    }
    

});


new ObjectsToCsv(not_there).toDisk('./compare_result.csv');



