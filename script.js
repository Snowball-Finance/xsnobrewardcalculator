const lodash = require('lodash');
const axios = require('axios');
const fs = require('fs');
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout
});

const settings = JSON.parse(fs.readFileSync('./settings.json'));
const listStrategyContracts = JSON.parse(fs.readFileSync('./strategycontracts.json'));
const { retrieveJOEPrice, retrieveTokenPriceInAVAX, retrieveAVAXPrice, retrieveAXIALPrice, retrieveVTXPrice } = require('./src/graph.js');
const { Constants } = require('./src/resources.js');

async function genericQuery(contractAddress, pagenumber, key, retries = 0) {
  if(retries < 3){
    try{
      return query = await axios({
        url: `${Constants.covalentAPIURL}${contractAddress}/transactions_v2/?key=${key}&page-number=${pagenumber}&page-size=500`,
        method: 'get'});
    }catch (error){
      console.error(error)
      let retry = retries + 1
      await genericQuery(contractAddress, pagenumber, key, retry);
    }
  }
}

function registerDate(date) {
  if (Date.parse(date) == NaN) {
    console.log('Invalid Date!');
    process.exit(1); //invalid date
  }
  return (new Date(date));
}

//test values
var starterDate;
var endingDate;


console.log(Constants.snowLogo);
console.log('See the Tokens harvested in all Snowglobes between 2 dates (UTC)!');
console.log('Beware that higher timeframes can take a lot of time to process.');
readStartingDate();


function readStartingDate() {
  readline.question('Input the Starter Date (yyyy-MM-dd):', date => {
    starterDate = registerDate(date);
    readEndingDate();
  });
}

function readEndingDate() {
  readline.question('Input the Ending Date (yyyy-MM-dd):', date => {
    endingDate = registerDate(date);
    readline.close();
    if (starterDate > endingDate) {
      console.log('Invalid date setup.');
      process.exit(1);
    }
    searchTransactions();

  });
}

async function searchTransactions() {
  let jsonObject = new Object;
  if (settings.saveToJSON) {
    jsonObject.contractList = [];
    jsonObject.starterDate = starterDate;
    jsonObject.endingDate = endingDate;
  }

  //internal function that does the covalent API query
  async function mountTransactionList(element, transactionList, pagenumber) {
    let queryResult = (await genericQuery(element.strategy, pagenumber, settings.covalentAPIKey)).data.data.items;
    transactionList = transactionList.concat(queryResult);
    let existsDate = lodash.filter(transactionList, function (o) {
      let blockDate = new Date(o.block_signed_at);
      let onlyDate = new Date(blockDate.toDateString());
      return starterDate >= onlyDate;
    });
    //dates exists or the address don't have more transactions
    if (existsDate.length > 0 || queryResult.length < 500) {
      return { result: true, list: transactionList };
    } else {
      console.log('Still Processing...');
      //recursive til find the date
      pagenumber += 1;
      return { result: false, list: transactionList, pagenumber: pagenumber };
    }
  }

  var tokensHarvested = {
    totalPNGHarvested:0,
    totalJOEHarvested:0,
    totalQIHarvested:0,
    totalWAVAXHarvested:0,
    totalAXIALHarvested:0,
    totalVTXHarvested:0
  }

  const JOEPrice = await retrieveJOEPrice();
  const AXIALPrice = await retrieveAXIALPrice();
  const PNGPrice = await retrieveTokenPriceInAVAX(Constants.PNGContract);
  const QIPrice = await retrieveTokenPriceInAVAX(Constants.QIContract);
  const VTXPrice = await retrieveVTXPrice();
  const AVAXValue = await retrieveAVAXPrice();
  let totalHarvested = [];

  var lenList = listStrategyContracts.length;
  var counter = 0;
  console.log(`Doing Calculations between ${starterDate} and ${endingDate}`);
  console.log('Queries are being performed... Wait a Little.');
  //for every snowglobe x staking pool
  do {
    let transactionsList = [];
    let listValidTransactions = [];

    var pagenumber = 0;
    foundDate = false;
    //search all transactions loosely between 2 dates (with skip/limit)
    while (!foundDate) {
      result = await mountTransactionList(listStrategyContracts[counter], transactionsList, pagenumber);
      foundDate = result.result;
      pagenumber = result.pagenumber;
      transactionsList = result.list;
    }

    //enforces the 2 dates
    listValidTransactions = lodash.filter(transactionsList, function (o) {
      let blockDate = new Date(o.block_signed_at);
      let onlyDate = new Date(blockDate.toDateString());
      return ((starterDate <= onlyDate) && (endingDate >= onlyDate));
    });

    //get only the internal transactions
    let allDecodedEvents = [];
    listValidTransactions.forEach((element) => {
      //only successful transactions
      if (element.successful) {
        element.log_events.forEach((element2) => {
          //only token transactions
          let tokenAddress = "";
          switch (listStrategyContracts[counter].protocol) {
            case 'Pangolin':
              tokenAddress = Constants.PNGContract;
              break;
            case 'Trader Joe':  case 'Banker Joe':
              tokenAddress = Constants.JoeContract;
              break;
            case 'AXIAL':
              tokenAddress = Constants.AXIALContract;
              break;
            case 'BENQI':
              tokenAddress = Constants.QIContract;
              break;
            case 'Vector':
              tokenAddress = Constants.VTXContract;
          }
          const senderAddress = element2.sender_address.toLowerCase();

          if (senderAddress === tokenAddress.toLowerCase() 
          || senderAddress === Constants.WAVAXContract.toLowerCase()
          || ((listStrategyContracts[counter].name === "PNG") 
            && (senderAddress === listStrategyContracts[counter].stakingAddress.toLowerCase()))
          ){
            if (element2.decoded) {
              element2.decoded.WAVAXIncentive = (senderAddress === Constants.WAVAXContract.toLowerCase());
              allDecodedEvents = allDecodedEvents.concat(element2.decoded);
            }
          }
        });
      }
    });
    listValidTransactions = [];
    
    //get only the transfer transactions
    let onlyTransfers = lodash.filter(allDecodedEvents, function (o) {
      return (
        o.name.startsWith('Transfer') && !(listStrategyContracts[counter].name === "PNG")) 
        || o.name.startsWith('Deposit') 
        || o.name.startsWith('RewardPaid');
    });
    allDecodedEvents = [];

    //check if the transfer transaction was made between the strategy contract and the staking contract
    //if it's made sum the amount of Token harvested in a variable.
    let contractHarvested = 0, contractHarvestedWAVAX = 0, contractUSDHarvested = 0;
    onlyTransfers.forEach((element) => {
      let validTo = false;
      let validFrom = false;
      const WAVAXIncentive = element.WAVAXIncentive;
      element.params.forEach((element2) => {
        if ((validTo && validFrom) || element2.name == "reward") {
          if (
            element2.name == 'value' 
            || (element2.name == 'wad' 
              && listStrategyContracts[counter].protocol != 'AAVE'
              && listStrategyContracts[counter].name != 'WAVAX'
              && listStrategyContracts[counter].name != 'WAVAX - Optimized')
            || element2.name == "reward"
          ) {
            if(WAVAXIncentive){
              tokensHarvested.totalWAVAXHarvested += (element2.value * 1);
              contractHarvestedWAVAX += (element2.value * 1);
              contractUSDHarvested += AVAXValue*(element2.value * 1 / 10 ** 18);
            }else{
              switch (listStrategyContracts[counter].protocol) {
                case 'Pangolin':
                  tokensHarvested.totalPNGHarvested += (element2.value * 1);
                  contractUSDHarvested += PNGPrice*(element2.value * 1 / 10 ** 18);
                  break;
                case 'AXIAL':
                  tokensHarvested.totalAXIALHarvested += (element2.value * 1);
                  contractUSDHarvested += AXIALPrice*(element2.value * 1 / 10 ** 18);
                  break;
                case 'Vector':
                  tokensHarvested.totalVTXHarvested += (element2.value * 1);
                  contractUSDHarvested += VTXPrice*(element2.value * 1 / 10 ** 18);
                  break;
                case 'Trader Joe': case 'Banker Joe':
                  tokensHarvested.totalJOEHarvested += (element2.value * 1);
                  contractUSDHarvested += JOEPrice*(element2.value * 1 / 10 ** 18);
                  break;
                case 'BENQI':
                  tokensHarvested.totalQIHarvested += (element2.value * 1);
                  contractUSDHarvested += QIPrice*(element2.value * 1 / 10 ** 18);
              }
              contractHarvested += (element2.value * 1);
            }
          }
        }
        if (element2.name === 'from') {
          if (element2.value.toLowerCase() ===
            listStrategyContracts[counter].stakingAddress.toLowerCase()
            || element2.value.toLowerCase() ===
            listStrategyContracts[counter].stakingAddress2
            || element2.value.toLowerCase() === Constants.ZeroAddress) {
              validFrom = true;
          };
        }
        if (element2.name == 'to' || element2.name == 'dst') {
          if(element2.name == 'dst'){
            validFrom = true;
          }
          validTo = (element2.value.toLowerCase() === listStrategyContracts[counter].strategy.toLowerCase());
        }
      });
    });

    if (settings.saveToJSON) {
      jsonObject.contractList.push({ contract: listStrategyContracts[counter].strategy, name: listStrategyContracts[counter].name, harvested: contractHarvested / 10 ** 18 });
    }
    const strategyResult = {
      name:listStrategyContracts[counter].name,
      protocol:listStrategyContracts[counter].protocol,
      USDValue:contractUSDHarvested
    };
    totalHarvested.push(strategyResult);
    counter++;
  } while (counter <= lenList - 1);

  totalHarvested = lodash.orderBy(totalHarvested,['USDValue'],['desc']);

  totalHarvested.forEach((element)=>{
    console.log(`Strategy: (${element.name} - ${element.protocol}) - Harvested: $${element.USDValue.toFixed(2)} `);
  });

  let valueHarvestedJOE, valueHarvestedPNG, valueHarvestedQI, valueHarvestedWAVAX, valueHarvestedAXIAL, valueHarvestedVTX;

  valueHarvestedJOE = JOEPrice * (tokensHarvested.totalJOEHarvested / 10 ** 18);
  valueHarvestedPNG = PNGPrice * (tokensHarvested.totalPNGHarvested / 10 ** 18);
  valueHarvestedQI = QIPrice * (tokensHarvested.totalQIHarvested / 10 ** 18);
  valueHarvestedAXIAL = AXIALPrice * (tokensHarvested.totalAXIALHarvested / 10 ** 18);
  valueHarvestedWAVAX = AVAXValue * (tokensHarvested.totalWAVAXHarvested / 10 ** 18);
  valueHarvestedVTX = VTXPrice * (tokensHarvested.totalVTXHarvested / 10 ** 18);

  console.log(`Total PNG Harvested: ${tokensHarvested.totalPNGHarvested / 10 ** 18}`);
  console.log(`Total JOE Harvested: ${tokensHarvested.totalJOEHarvested / 10 ** 18}`);
  console.log(`Total QI Harvested: ${tokensHarvested.totalQIHarvested / 10 ** 18}`);
  console.log(`Total AXIAL Harvested: ${tokensHarvested.totalAXIALHarvested / 10 ** 18}`);
  console.log(`Total WAVAX Harvested: ${tokensHarvested.totalWAVAXHarvested / 10 ** 18}`);
  console.log(`Total VTX Harvested: ${tokensHarvested.totalVTXHarvested / 10 ** 18}`);

  console.log(`JOE Value Harvested: $${valueHarvestedJOE} 
    PNG Value Harvested: $${valueHarvestedPNG} 
    QI Value Harvested: $${valueHarvestedQI} 
    WAVAX Value Harvested: $${valueHarvestedWAVAX} 
    AXIAL Value Harvested: $${valueHarvestedAXIAL} 
    VTX Value Harvested: $${valueHarvestedVTX} 
    Total Value Harvested: $${valueHarvestedJOE + valueHarvestedPNG + valueHarvestedQI + valueHarvestedWAVAX + valueHarvestedAXIAL + valueHarvestedVTX}`);
}
