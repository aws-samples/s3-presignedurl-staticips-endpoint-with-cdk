import {handler} from "../resources/presign";


const testEvent = {
    resource: '/',
    path: '/presign/objects/test-file',
    httpMethod: 'GET',
}



describe("handler", () => {
    beforeEach(()=>{});

    it("run handler", async () => {

        const response = await handler(testEvent);
        expect(response.statusCode).toEqual(301);
    });

});