const { describe, it } = require("mocha"),
    should = require("should"),
    connect = require("./connect")

describe("connect()", () => {
    var api 
    before(() => {
        return connect()
            .should.be.fulfilled()
            .then(a => api = a)
    })
    it("authentication", () => {
        api.should.have.property("_token")
    })
})     