var chai = require('chai');
var assert = chai.assert;
var Apollo = require(__dirname +'/../libs/apollo');


var conf;
switch(process.env.TRAVIS){
    case 'true':
        conf = {
            "hosts": [
                "127.0.0.1"
            ],
            "keyspace": "tests"
        };
        break;
    default:
        conf = {
            "hosts": [
                "192.168.100.61",
                "192.168.100.62"
            ],
            "keyspace": "tests"
        };
        break;
}
console.log(process.env);
connection = conf;

var ap;



beforeEach(function(done) {
    if(ap)
        ap.close();

    // Setup
    Apollo.assert_keyspace(connection,function(err,result){ 
        if(err)
            console.log(err);
        else {
            ap = new Apollo(connection);
        }
        done();
    });
});



describe('Smart Libs -> ', function(){

    describe('Apollo -> ', function(){

        var model_test1 = { 
            fields:{v1:"int",v2:"int"}, 
            key:["v1"] 
        };

        it('add model', function(done){
            ap.add_model("test1", model_test1, true, function(err,data){
                if(err) 
                    console.log('err: '+err);
                done();
            });
            
        });

        it('pig update', function(done){
            ap.add_model("test1", model_test1, true, function(err,data){
                ap.pig_cql_update_connection("test1",true, function(err,data){
                    if(err) 
                        console.log('err: '+err);
                    else 
                        console.log(data);
                    done();
                });
            });

        });

        it('generate model', function(){
            var TestModel = ap._generate_model(model_test1);
            var ins = new TestModel({'v1': 500});
            ins.save();
            TestModel.find();
            console.log(ins.v1, ins.v2);
            for(var i in ins){
                console.log(i);
            }


        });

    });

});

