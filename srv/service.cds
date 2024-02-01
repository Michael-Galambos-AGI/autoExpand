using {autoExpand} from '../db/schema';

service Service {
    entity Tags        as projection on autoExpand.Tags

    @readonly
    entity Types       as projection on autoExpand.Types

    @readonly
    entity APIProjects as projection on autoExpand.Projects

    @readonly
    entity WBSElements as projection on autoExpand.WBSElements;
}
